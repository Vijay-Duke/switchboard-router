package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
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
