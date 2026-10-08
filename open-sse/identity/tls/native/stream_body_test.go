package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"
)

const bridgeWire = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"synthetic\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"synthetic\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

func compressedPayload(data []byte) []byte {
	var out bytes.Buffer
	writer := gzip.NewWriter(&out)
	_, _ = writer.Write(data)
	_ = writer.Close()
	return out.Bytes()
}

func writeFixtureResponse(server net.Conn, status int, contentType string, compressed bool, release <-chan struct{}) {
	defer server.Close()
	req, err := http.ReadRequest(bufio.NewReader(server))
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, req.Body)
	req.Body.Close()
	payload := []byte(bridgeWire)
	encoding := ""
	if compressed {
		payload = compressedPayload(payload)
		encoding = "Content-Encoding: gzip\r\n"
	}
	_, err = fmt.Fprintf(server, "HTTP/1.1 %d Fixture\r\nContent-Type: %s\r\n%sContent-Length: %d\r\n\r\n", status, contentType, encoding, len(payload))
	if err != nil {
		return
	}
	<-release
	_, _ = server.Write(payload)
}

// A test-only helper process exercises the real one-shot metadata/body protocol.
// Production go build excludes this file; the peer is always an in-memory pipe.
func TestMain(m *testing.M) {
	if os.Getenv("SWITCHBOARD_TEST_SSE_BODY_BRIDGE") == "1" {
		dialTLSForRequest = func(context.Context, *url.URL, string, time.Time) (tlsConnection, error) {
			client, server := net.Pipe()
			release := make(chan struct{})
			go writeFixtureResponse(server, 200, "text/event-stream", os.Getenv("SWITCHBOARD_TEST_SSE_GZIP") == "1", release)
			time.AfterFunc(150*time.Millisecond, func() { close(release) })
			return &passthroughTLSConnection{Conn: client}, nil
		}
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fixtureResult struct {
	response     *http.Response
	err          error
	setupContext context.Context
}

func pendingFixture(t *testing.T, status int, contentType string, compressed bool, timeout int64, wrap func(net.Conn) net.Conn) (<-chan fixtureResult, func()) {
	t.Helper()
	original := dialTLSForRequest
	client, server := net.Pipe()
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(func() { client.Close(); server.Close(); unblock(); dialTLSForRequest = original })
	if wrap == nil {
		wrap = func(conn net.Conn) net.Conn { return conn }
	}
	var setupContext context.Context
	dialTLSForRequest = func(ctx context.Context, _ *url.URL, _ string, _ time.Time) (tlsConnection, error) {
		setupContext = ctx
		return &passthroughTLSConnection{Conn: wrap(client)}, nil
	}
	go writeFixtureResponse(server, status, contentType, compressed, release)
	result := make(chan fixtureResult, 1)
	go func() {
		response, err := roundTrip(requestMeta{URL: "https://synthetic.invalid/", Method: "GET", ALPN: []string{"http/1.1"}, TimeoutMS: timeout}, nil)
		result <- fixtureResult{response, err, setupContext}
	}()
	return result, unblock
}

func awaitMetadata(t *testing.T, result <-chan fixtureResult) *http.Response {
	t.Helper()
	select {
	case received := <-result:
		if received.err != nil {
			t.Fatalf("response metadata failed: %v", received.err)
		}
		if received.setupContext.Err() != context.Canceled {
			t.Fatal("setup context remained live after response headers")
		}
		return received.response
	case <-time.After(200 * time.Millisecond):
		t.Fatal("metadata waited for body bytes")
		return nil
	}
}

func TestSSEBodyOutlivesSuccessfulHeaderDeadline(t *testing.T) {
	result, release := pendingFixture(t, 200, "Text/Event-Stream; charset=utf-8", false, 50, nil)
	response := awaitMetadata(t, result)
	defer response.Body.Close()
	time.Sleep(100 * time.Millisecond)
	release()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != bridgeWire {
		t.Fatalf("late SSE body = %q, error=%v", body, err)
	}
}

func TestSSEGzipMetadataDoesNotWaitForCompressedBody(t *testing.T) {
	result, release := pendingFixture(t, 200, "text/event-stream", true, 50, nil)
	response := awaitMetadata(t, result)
	defer response.Body.Close()
	if response.Header.Get("Content-Encoding") != "" || response.Header.Get("Content-Length") != "" {
		t.Fatal("decompressed stream retained compressed representation headers")
	}
	time.Sleep(100 * time.Millisecond)
	release()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != bridgeWire {
		t.Fatalf("late gzip SSE body = %q, error=%v", body, err)
	}
}

func TestSSECloseInterruptsAnUnreadBody(t *testing.T) {
	for _, compressed := range []bool{false, true} {
		t.Run(fmt.Sprintf("gzip=%v", compressed), func(t *testing.T) {
			result, _ := pendingFixture(t, 200, "text/event-stream", compressed, 2000, nil)
			response := awaitMetadata(t, result)
			closed := make(chan struct{})
			go func() { response.Body.Close(); close(closed) }()
			select {
			case <-closed:
			case <-time.After(200 * time.Millisecond):
				t.Fatal("SSE Close waited to drain an unread body")
			}
		})
	}
}

func TestFailedSSEKeepsBoundedBodyDeadline(t *testing.T) {
	result, _ := pendingFixture(t, 503, "text/event-stream", false, 50, nil)
	response := awaitMetadata(t, result)
	defer response.Body.Close()
	_, err := io.ReadAll(response.Body)
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("error body read = %v, want timeout", err)
	}
}

type clearFailureConn struct {
	net.Conn
	err    error
	closed chan struct{}
}

func (c *clearFailureConn) SetDeadline(deadline time.Time) error {
	if deadline.IsZero() {
		return c.err
	}
	return c.Conn.SetDeadline(deadline)
}
func (c *clearFailureConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return c.Conn.Close()
}

func TestSSEDeadlineClearFailureClosesConnection(t *testing.T) {
	want := errors.New("cannot clear deadline")
	closed := make(chan struct{})
	result, _ := pendingFixture(t, 200, "text/event-stream", false, 2000, func(conn net.Conn) net.Conn { return &clearFailureConn{conn, want, closed} })
	select {
	case got := <-result:
		if !errors.Is(got.err, want) || got.response != nil {
			t.Fatalf("roundTrip = %v,%v; want clear failure", got.response, got.err)
		}
		select {
		case <-closed:
		default:
			t.Fatal("connection not closed after deadline clear failure")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("deadline clear failure waited for response body")
	}
}
