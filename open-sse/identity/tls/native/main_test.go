package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	tls "github.com/refraction-networking/utls"
)

type contextDialerFunc func(context.Context, string, string) (net.Conn, error)

func (f contextDialerFunc) Dial(network, address string) (net.Conn, error) {
	return f(context.Background(), network, address)
}

func (f contextDialerFunc) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return f(ctx, network, address)
}

type deadlineConn struct {
	deadline    time.Time
	deadlineErr error
	closed      bool
}

func (c *deadlineConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (c *deadlineConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *deadlineConn) Close() error                     { c.closed = true; return nil }
func (c *deadlineConn) LocalAddr() net.Addr              { return nil }
func (c *deadlineConn) RemoteAddr() net.Addr             { return nil }
func (c *deadlineConn) SetDeadline(t time.Time) error    { c.deadline = t; return c.deadlineErr }
func (c *deadlineConn) SetReadDeadline(time.Time) error  { return nil }
func (c *deadlineConn) SetWriteDeadline(time.Time) error { return nil }

func TestClientHelloMatchesClaudeCode302Capture(t *testing.T) {
	spec := clientHelloSpec()
	var curves []tls.CurveID
	var keyShares []tls.KeyShare
	var signatureAlgorithms []tls.SignatureScheme
	var extensionOrder []string
	for _, extension := range spec.Extensions {
		switch ext := extension.(type) {
		case *tls.SNIExtension:
			extensionOrder = append(extensionOrder, "server_name")
		case *tls.ExtendedMasterSecretExtension:
			extensionOrder = append(extensionOrder, "extended_master_secret")
		case *tls.RenegotiationInfoExtension:
			extensionOrder = append(extensionOrder, "renegotiation_info")
		case *tls.SupportedCurvesExtension:
			extensionOrder = append(extensionOrder, "supported_groups")
			curves = ext.Curves
		case *tls.SupportedPointsExtension:
			extensionOrder = append(extensionOrder, "ec_point_formats")
		case *tls.SessionTicketExtension:
			extensionOrder = append(extensionOrder, "session_ticket")
		case *tls.ALPNExtension:
			extensionOrder = append(extensionOrder, "alpn")
		case *tls.StatusRequestExtension:
			extensionOrder = append(extensionOrder, "status_request")
		case *tls.SignatureAlgorithmsExtension:
			extensionOrder = append(extensionOrder, "signature_algorithms")
			signatureAlgorithms = ext.SupportedSignatureAlgorithms
		case *tls.SCTExtension:
			extensionOrder = append(extensionOrder, "signed_certificate_timestamp")
		case *tls.KeyShareExtension:
			extensionOrder = append(extensionOrder, "key_share")
			keyShares = ext.KeyShares
		case *tls.PSKKeyExchangeModesExtension:
			extensionOrder = append(extensionOrder, "psk_key_exchange_modes")
		case *tls.SupportedVersionsExtension:
			extensionOrder = append(extensionOrder, "supported_versions")
		default:
			t.Fatalf("unexpected extension %T in Claude Code 2.1.302 capture", extension)
		}
	}
	wantCiphers := []uint16{
		tls.TLS_AES_128_GCM_SHA256, tls.TLS_AES_256_GCM_SHA384, tls.TLS_CHACHA20_POLY1305_SHA256,
		tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
		tls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
		tls.TLS_RSA_WITH_AES_128_GCM_SHA256, tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
		tls.TLS_RSA_WITH_AES_128_CBC_SHA, tls.TLS_RSA_WITH_AES_256_CBC_SHA,
	}
	if !slices.Equal(spec.CipherSuites, wantCiphers) {
		t.Fatalf("cipher suites = %v, want %v", spec.CipherSuites, wantCiphers)
	}
	wantExtensions := []string{
		"server_name", "extended_master_secret", "renegotiation_info", "supported_groups",
		"ec_point_formats", "session_ticket", "alpn", "status_request", "signature_algorithms",
		"signed_certificate_timestamp", "key_share", "psk_key_exchange_modes", "supported_versions",
	}
	if !slices.Equal(extensionOrder, wantExtensions) {
		t.Fatalf("extensions = %v, want %v", extensionOrder, wantExtensions)
	}
	wantCurves := []tls.CurveID{tls.X25519MLKEM768, tls.X25519, tls.CurveP256, tls.CurveP384}
	if !slices.Equal(curves, wantCurves) {
		t.Fatalf("supported curves = %v, want %v", curves, wantCurves)
	}
	if len(keyShares) != 2 || keyShares[0].Group != tls.X25519MLKEM768 || keyShares[1].Group != tls.X25519 {
		t.Fatalf("key shares = %v, want X25519MLKEM768 then X25519", keyShares)
	}
	// Bun 1.4.4 (Claude Code 2.1.302) added Ed25519 + ECDSA-P521 to the 2.1.289 list.
	wantSignatureAlgorithms := []tls.SignatureScheme{
		tls.ECDSAWithP256AndSHA256, tls.PSSWithSHA256, tls.PKCS1WithSHA256, tls.ECDSAWithP384AndSHA384,
		tls.PSSWithSHA384, tls.PKCS1WithSHA384, tls.PSSWithSHA512, tls.PKCS1WithSHA512,
		tls.Ed25519, tls.ECDSAWithP521AndSHA512, tls.PKCS1WithSHA1,
	}
	if !slices.Equal(signatureAlgorithms, wantSignatureAlgorithms) {
		t.Fatalf("signature algorithms = %v, want %v", signatureAlgorithms, wantSignatureAlgorithms)
	}
}

func TestKeyShareStateMatchesClaudeCode302(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	conn := tls.UClient(client, &tls.Config{ServerName: "localhost"}, tls.HelloCustom)
	if err := conn.ApplyPreset(clientHelloSpec()); err != nil {
		t.Fatal(err)
	}
	// uTLS handshake reads Ecdhe when the server selects plain X25519 and
	// MlkemEcdhe+Mlkem when it selects X25519MLKEM768. Claude Code sends both
	// shares, so all three keys must exist and the two X25519 keys differ.
	keys := conn.HandshakeState.State13.KeyShareKeys
	if keys.Ecdhe == nil || keys.MlkemEcdhe == nil || keys.Mlkem == nil {
		t.Fatalf("key share state incomplete: ecdhe=%v mlkemEcdhe=%v mlkem=%v", keys.Ecdhe != nil, keys.MlkemEcdhe != nil, keys.Mlkem != nil)
	}
	if keys.Ecdhe == keys.MlkemEcdhe {
		t.Fatal("plain X25519 key share aliases the hybrid ML-KEM ECDHE key")
	}
}

func TestDialTLSUsesContextDialerAndSetsConnectionDeadline(t *testing.T) {
	originalBuildDialer := buildDialerForRequest
	originalWrapTLS := wrapTLSConn
	t.Cleanup(func() {
		buildDialerForRequest = originalBuildDialer
		wrapTLSConn = originalWrapTLS
	})

	conn := &deadlineConn{}
	contextReachedDialer := false
	buildDialerForRequest = func(string) (proxyDialer, error) {
		return contextDialerFunc(func(ctx context.Context, _, _ string) (net.Conn, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
				contextReachedDialer = true
				return conn, nil
			}
		}), nil
	}
	wrapTLSConn = func(raw net.Conn, _ *tls.Config) tlsConnection {
		return &fakeTLSConnection{Conn: raw}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	u, _ := url.Parse("https://example.com/")
	tlsConn, err := dialTLS(ctx, u, "", time.Now().Add(500*time.Millisecond))
	if err != nil {
		t.Fatalf("dialTLS returned error: %v", err)
	}
	defer tlsConn.Close()
	if !contextReachedDialer {
		t.Fatal("dial context did not reach the configured dialer")
	}
	if conn.deadline.IsZero() {
		t.Fatal("connection deadline was not set")
	}
}

func TestDialTLSHonorsCanceledDialContext(t *testing.T) {
	originalBuildDialer := buildDialerForRequest
	t.Cleanup(func() { buildDialerForRequest = originalBuildDialer })

	buildDialerForRequest = func(string) (proxyDialer, error) {
		return contextDialerFunc(func(ctx context.Context, _, _ string) (net.Conn, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return &deadlineConn{}, nil
		}), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	u, _ := url.Parse("https://example.com/")
	_, err := dialTLS(ctx, u, "", time.Now().Add(time.Second))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("dialTLS error = %v, want context canceled", err)
	}
}

func TestDialTLSHonorsCanceledHandshakeContext(t *testing.T) {
	originalBuildDialer := buildDialerForRequest
	originalWrapTLS := wrapTLSConn
	t.Cleanup(func() {
		buildDialerForRequest = originalBuildDialer
		wrapTLSConn = originalWrapTLS
	})

	conn := &deadlineConn{}
	buildDialerForRequest = func(string) (proxyDialer, error) {
		return contextDialerFunc(func(context.Context, string, string) (net.Conn, error) { return conn, nil }), nil
	}
	wrapTLSConn = func(raw net.Conn, _ *tls.Config) tlsConnection {
		return &fakeTLSConnection{Conn: raw, waitForContext: true}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	u, _ := url.Parse("https://example.com/")
	_, err := dialTLS(ctx, u, "", time.Now().Add(time.Second))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("dialTLS error = %v, want context canceled", err)
	}
	if !conn.closed {
		t.Fatal("connection was not closed after handshake cancellation")
	}
}

func TestDialTLSReturnsConnectionDeadlineError(t *testing.T) {
	originalBuildDialer := buildDialerForRequest
	t.Cleanup(func() { buildDialerForRequest = originalBuildDialer })

	want := errors.New("deadline failed")
	conn := &deadlineConn{deadlineErr: want}
	buildDialerForRequest = func(string) (proxyDialer, error) {
		return contextDialerFunc(func(context.Context, string, string) (net.Conn, error) { return conn, nil }), nil
	}

	u, _ := url.Parse("https://example.com/")
	_, err := dialTLS(context.Background(), u, "", time.Now().Add(time.Second))
	if !errors.Is(err, want) {
		t.Fatalf("dialTLS error = %v, want %v", err, want)
	}
	if !conn.closed {
		t.Fatal("connection was not closed after deadline setup failed")
	}
}

func TestRoundTripRequestWriteFailsAtConnectionDeadline(t *testing.T) {
	originalDialTLS := dialTLSForRequest
	t.Cleanup(func() { dialTLSForRequest = originalDialTLS })

	client, server := net.Pipe()
	dialTLSForRequest = func(context.Context, *url.URL, string, time.Time) (tlsConnection, error) {
		return &passthroughTLSConnection{Conn: client}, nil
	}
	defer server.Close()

	_, err := roundTrip(requestMeta{
		URL: "https://example.com/", Method: "POST", ALPN: []string{"http/1.1"}, TimeoutMS: 20, BodyLength: 1,
	}, strings.NewReader("x"))
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("roundTrip error = %v, want request write timeout", err)
	}
}

func TestRoundTripResponseHeadersFailAtConnectionDeadline(t *testing.T) {
	originalDialTLS := dialTLSForRequest
	t.Cleanup(func() { dialTLSForRequest = originalDialTLS })

	client, server := net.Pipe()
	dialTLSForRequest = func(context.Context, *url.URL, string, time.Time) (tlsConnection, error) {
		return &passthroughTLSConnection{Conn: client}, nil
	}
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		defer server.Close()
		request, err := http.ReadRequest(bufio.NewReader(server))
		if err == nil {
			request.Body.Close()
			_, _ = io.Copy(io.Discard, server)
		}
	}()

	_, err := roundTrip(requestMeta{
		URL: "https://example.com/", Method: "GET", ALPN: []string{"http/1.1"}, TimeoutMS: 20,
	}, nil)
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("roundTrip error = %v, want header timeout", err)
	}
	<-serverDone
}

func TestRoundTripBodyReadFailsAtConnectionDeadline(t *testing.T) {
	originalDialTLS := dialTLSForRequest
	t.Cleanup(func() { dialTLSForRequest = originalDialTLS })

	client, server := net.Pipe()
	deadlineConn := &deadlineConnWrapper{Conn: client}
	dialTLSForRequest = func(context.Context, *url.URL, string, time.Time) (tlsConnection, error) {
		return &passthroughTLSConnection{Conn: deadlineConn}, nil
	}

	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		defer server.Close()
		reader := bufio.NewReader(server)
		request, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		request.Body.Close()
		_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na")
		_, _ = io.Copy(io.Discard, reader)
	}()

	response, err := roundTrip(requestMeta{
		URL: "https://example.com/", Method: "GET", ALPN: []string{"http/1.1"}, TimeoutMS: 20,
	}, nil)
	if err != nil {
		t.Fatalf("roundTrip returned error: %v", err)
	}
	defer response.Body.Close()
	if deadlineConn.deadline.IsZero() {
		t.Fatal("roundTrip did not set a body deadline on the connection")
	}

	_, err = io.ReadAll(response.Body)
	if err == nil {
		t.Fatal("body read unexpectedly completed")
	}
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("body read error = %v, want timeout", err)
	}
	response.Body.Close()
	<-serverDone
}

type failingBody struct {
	data []byte
	err  error
}

func (b *failingBody) Read(p []byte) (int, error) {
	if len(b.data) > 0 {
		n := copy(p, b.data)
		b.data = b.data[n:]
		return n, nil
	}
	return 0, b.err
}

func TestCopyResponseBodyReturnsReadError(t *testing.T) {
	want := errors.New("read timed out")
	var output strings.Builder
	err := copyResponseBody(&output, &failingBody{data: []byte("partial"), err: want})
	if !errors.Is(err, want) {
		t.Fatalf("copyResponseBody error = %v, want %v", err, want)
	}
	if output.String() != "partial" {
		t.Fatalf("copyResponseBody output = %q, want partial", output.String())
	}
}

type deadlineConnWrapper struct {
	net.Conn
	deadline time.Time
}

func (c *deadlineConnWrapper) SetDeadline(deadline time.Time) error {
	c.deadline = deadline
	return c.Conn.SetDeadline(deadline)
}

type fakeTLSConnection struct {
	net.Conn
	waitForContext bool
}

func (c *fakeTLSConnection) ApplyPreset(*tls.ClientHelloSpec) error { return nil }
func (c *fakeTLSConnection) HandshakeContext(ctx context.Context) error {
	if c.waitForContext {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}
func (c *fakeTLSConnection) ConnectionState() tls.ConnectionState {
	return tls.ConnectionState{NegotiatedProtocol: "http/1.1"}
}

type passthroughTLSConnection struct{ net.Conn }

func (c *passthroughTLSConnection) ApplyPreset(*tls.ClientHelloSpec) error { return nil }
func (c *passthroughTLSConnection) HandshakeContext(context.Context) error { return nil }
func (c *passthroughTLSConnection) ConnectionState() tls.ConnectionState {
	return tls.ConnectionState{NegotiatedProtocol: "http/1.1"}
}
