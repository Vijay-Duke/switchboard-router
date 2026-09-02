package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	tls "github.com/refraction-networking/utls"
	"golang.org/x/net/proxy"
)

const (
	sessionCacheCapacity = 32
	defaultTimeout       = 60 * time.Second
)

var sessionCache = tls.NewLRUClientSessionCache(sessionCacheCapacity)

type proxyDialer interface {
	proxy.Dialer
	proxy.ContextDialer
}

type tlsConnection interface {
	net.Conn
	ApplyPreset(*tls.ClientHelloSpec) error
	HandshakeContext(context.Context) error
	ConnectionState() tls.ConnectionState
}

var (
	buildDialerForRequest = buildDialer
	dialTLSForRequest     = dialTLS
	wrapTLSConn           = func(conn net.Conn, config *tls.Config) tlsConnection {
		return tls.UClient(conn, config, tls.HelloCustom)
	}
)

type requestMeta struct {
	URL         string      `json:"url"`
	Method      string      `json:"method"`
	Headers     [][2]string `json:"headers"`
	HeaderOrder []string    `json:"headerOrder"`
	ProxyURL    string      `json:"proxyUrl"`
	TLSSpecRev  string      `json:"tlsSpecRev"`
	ALPN        []string    `json:"alpn"`
	BodyLength  int64       `json:"bodyLength"`
	TimeoutMS   int64       `json:"timeoutMs"`
}

type responseMeta struct {
	Status     int         `json:"status,omitempty"`
	StatusText string      `json:"statusText,omitempty"`
	Headers    [][2]string `json:"headers,omitempty"`
	Error      string      `json:"error,omitempty"`
}

func clientHelloSpec() *tls.ClientHelloSpec {
	return &tls.ClientHelloSpec{
		CipherSuites: []uint16{
			tls.TLS_AES_128_GCM_SHA256, tls.TLS_AES_256_GCM_SHA384, tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			tls.TLS_RSA_WITH_AES_128_GCM_SHA256, tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_RSA_WITH_AES_128_CBC_SHA, tls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []uint8{0},
		Extensions: []tls.TLSExtension{
			&tls.SNIExtension{}, &tls.ExtendedMasterSecretExtension{},
			&tls.RenegotiationInfoExtension{Renegotiation: tls.RenegotiateOnceAsClient},
			&tls.SupportedCurvesExtension{Curves: []tls.CurveID{tls.X25519MLKEM768, tls.X25519, tls.CurveP256, tls.CurveP384}},
			&tls.SupportedPointsExtension{SupportedPoints: []byte{0}}, &tls.SessionTicketExtension{},
			&tls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}}, &tls.StatusRequestExtension{},
			&tls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []tls.SignatureScheme{
				tls.ECDSAWithP256AndSHA256, tls.PSSWithSHA256, tls.PKCS1WithSHA256, tls.ECDSAWithP384AndSHA384,
				tls.PSSWithSHA384, tls.PKCS1WithSHA384, tls.PSSWithSHA512, tls.PKCS1WithSHA512, tls.PKCS1WithSHA1,
			}},
			&tls.SCTExtension{}, &tls.KeyShareExtension{KeyShares: []tls.KeyShare{{Group: tls.X25519MLKEM768}}},
			&tls.PSKKeyExchangeModesExtension{Modes: []uint8{tls.PskModeDHE}},
			&tls.SupportedVersionsExtension{Versions: []uint16{tls.VersionTLS13, tls.VersionTLS12}},
		},
	}
}

func prepareClaude258MLKEMState(conn *tls.UConn) {
	keys := conn.HandshakeState.State13.KeyShareKeys
	if keys != nil && keys.Ecdhe == nil && keys.MlkemEcdhe != nil {
		// uTLS 1.8.2 custom presets generate the hybrid ECDHE key in
		// MlkemEcdhe, but TLS 1.3 reads Ecdhe before applying its ML-KEM path.
		keys.Ecdhe = keys.MlkemEcdhe
	}
}
func buildDialer(proxyURL string) (proxyDialer, error) {
	direct := &net.Dialer{}
	if proxyURL == "" {
		return direct, nil
	}
	u, err := url.Parse(proxyURL)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(u.Scheme, "socks5") && !strings.EqualFold(u.Scheme, "socks5h") {
		return nil, fmt.Errorf("proxy scheme %q is not safely supported by Claude TLS helper", u.Scheme)
	}
	var auth *proxy.Auth
	if u.User != nil {
		password, _ := u.User.Password()
		auth = &proxy.Auth{User: u.User.Username(), Password: password}
	}
	dialer, err := proxy.SOCKS5("tcp", u.Host, auth, direct)
	if err != nil {
		return nil, err
	}
	contextDialer, ok := dialer.(proxy.ContextDialer)
	if !ok {
		return nil, errors.New("SOCKS5 dialer does not support context cancellation")
	}
	return struct {
		proxy.Dialer
		proxy.ContextDialer
	}{Dialer: dialer, ContextDialer: contextDialer}, nil
}

func dialTLS(ctx context.Context, u *url.URL, proxyURL string, deadline time.Time) (tlsConnection, error) {
	dialer, err := buildDialerForRequest(proxyURL)
	if err != nil {
		return nil, err
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(u.Hostname(), port))
	if err != nil {
		return nil, err
	}
	if err = conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return nil, err
	}
	tlsConn := wrapTLSConn(conn, &tls.Config{
		ServerName: u.Hostname(), ClientSessionCache: sessionCache,
		OmitEmptyPsk: true, PreferSkipResumptionOnNilExtension: true,
	})
	if err = tlsConn.ApplyPreset(clientHelloSpec()); err != nil {
		tlsConn.Close()
		return nil, err
	}
	if conn, ok := tlsConn.(*tls.UConn); ok {
		prepareClaude258MLKEMState(conn)
	}
	if err = tlsConn.HandshakeContext(ctx); err != nil {
		tlsConn.Close()
		return nil, err
	}
	if tlsConn.ConnectionState().NegotiatedProtocol != "http/1.1" {
		tlsConn.Close()
		return nil, errors.New("upstream did not negotiate HTTP/1.1")
	}
	return tlsConn, nil
}

func writeRequest(conn io.Writer, meta requestMeta, u *url.URL, body io.Reader) error {
	headers := append([][2]string(nil), meta.Headers...)
	setDefault := func(name, value string) {
		for _, pair := range headers {
			if strings.EqualFold(pair[0], name) {
				return
			}
		}
		headers = append(headers, [2]string{name, value})
	}
	setDefault("Host", u.Host)
	setDefault("Connection", "close")
	setDefault("Accept-Encoding", "gzip")
	if meta.BodyLength > 0 {
		setDefault("Content-Length", strconv.FormatInt(meta.BodyLength, 10))
	}

	used := make([]bool, len(headers))
	ordered := make([][2]string, 0, len(headers))
	for _, wanted := range meta.HeaderOrder {
		for i, pair := range headers {
			if !used[i] && strings.EqualFold(pair[0], wanted) {
				ordered = append(ordered, pair)
				used[i] = true
			}
		}
	}
	for i, pair := range headers {
		if !used[i] {
			ordered = append(ordered, pair)
		}
	}

	target := u.EscapedPath()
	if target == "" {
		target = "/"
	}
	if u.RawQuery != "" {
		target += "?" + u.RawQuery
	}
	if _, err := fmt.Fprintf(conn, "%s %s HTTP/1.1\r\n", meta.Method, target); err != nil {
		return err
	}
	for _, pair := range ordered {
		if _, err := fmt.Fprintf(conn, "%s: %s\r\n", pair[0], pair[1]); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(conn, "\r\n"); err != nil {
		return err
	}
	if meta.BodyLength > 0 {
		written, err := io.CopyN(conn, body, meta.BodyLength)
		if err != nil {
			return err
		}
		if written != meta.BodyLength {
			return io.ErrUnexpectedEOF
		}
	}
	return nil
}

type closingBody struct {
	io.Reader
	closers []io.Closer
}

func (b *closingBody) Close() error {
	var result error
	for _, closer := range b.closers {
		result = errors.Join(result, closer.Close())
	}
	return result
}

func roundTrip(meta requestMeta, body io.Reader) (*http.Response, error) {
	u, err := url.Parse(meta.URL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" {
		return nil, errors.New("Claude TLS helper requires https")
	}
	if len(meta.ALPN) != 1 || meta.ALPN[0] != "http/1.1" {
		return nil, errors.New("Claude TLS helper requires ALPN http/1.1 only")
	}
	timeout := time.Duration(meta.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	deadline, _ := ctx.Deadline()
	conn, err := dialTLSForRequest(ctx, u, meta.ProxyURL, deadline)
	if err != nil {
		return nil, err
	}
	if err = conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return nil, err
	}
	if err = writeRequest(conn, meta, u, body); err != nil {
		conn.Close()
		return nil, err
	}
	req := &http.Request{Method: meta.Method, URL: u}
	response, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if strings.EqualFold(response.Header.Get("Content-Encoding"), "gzip") {
		gz, gzipErr := gzip.NewReader(response.Body)
		if gzipErr != nil {
			response.Body.Close()
			conn.Close()
			return nil, gzipErr
		}
		response.Body = &closingBody{Reader: gz, closers: []io.Closer{gz, response.Body, conn}}
		response.Header.Del("Content-Encoding")
		response.Header.Del("Content-Length")
	} else {
		response.Body = &closingBody{Reader: response.Body, closers: []io.Closer{response.Body, conn}}
	}
	return response, nil
}

func copyResponseBody(dst io.Writer, src io.Reader) error {
	_, err := io.Copy(dst, src)
	return err
}

func main() {
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		writeError(err)
		return
	}
	var meta requestMeta
	if err = json.Unmarshal(line, &meta); err != nil {
		writeError(err)
		return
	}
	response, err := roundTrip(meta, io.LimitReader(reader, meta.BodyLength))
	if err != nil {
		writeError(err)
		return
	}
	defer response.Body.Close()
	headers := make([][2]string, 0)
	for name, values := range response.Header {
		for _, value := range values {
			headers = append(headers, [2]string{name, value})
		}
	}
	writeMeta(responseMeta{Status: response.StatusCode, StatusText: response.Status, Headers: headers})
	if err = copyResponseBody(os.Stdout, response.Body); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "Claude TLS helper response body failed: %v\n", err)
		os.Exit(1)
	}
}

func writeError(err error) { writeMeta(responseMeta{Error: err.Error()}) }
func writeMeta(meta responseMeta) {
	encoded, _ := json.Marshal(meta)
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}
