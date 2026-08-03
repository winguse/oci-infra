// h2 - HTTP/2 CONNECT through the Envoy forward proxy.
//
// Demonstrates that HTTP/2 CONNECT authenticates (returns 200 with a valid
// Proxy-Authorization) but does NOT relay actual tunneled bytes: after the
// 200 the response stream carries no data (the tunneled GET times out).
//
// This reproduces the known Envoy limitation: only HTTP/1.1 CONNECT fully
// tunnels payload bytes; HTTP/2 (and HTTP/3) authenticate but drop the data.
//
// Build:   go build -o h2 .
// Run:
//   PROXY_HOST=170.9.16.247 PROXY_PORT=443 PROXY_AUTH=<base64(user:pass)> \
//       TARGET_HOST=example.com TARGET_PORT=80 ./h2
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"golang.org/x/net/http2"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	host := envOr("PROXY_HOST", "127.0.0.1")
	port := envOr("PROXY_PORT", "443")
	auth := envOr("PROXY_AUTH", "Basic dXV1OmNlNTNjeFZ1NzZma0RI")
	target := envOr("TARGET_HOST", "example.com")
	tport := envOr("TARGET_PORT", "80")

	addr := fmt.Sprintf("%s:%s", host, port)
	raw, err := tls.Dial("tcp", addr, &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{"h2"},
	})
	if err != nil {
		fmt.Println("TLS dial error:", err)
		os.Exit(1)
	}
	fmt.Println("ALPN:", raw.ConnectionState().NegotiatedProtocol)
	cc, err := (&http2.Transport{}).NewClientConn(raw)
	if err != nil {
		fmt.Println("h2 client conn error:", err)
		os.Exit(1)
	}
	defer cc.Close()

	req, _ := http.NewRequest("CONNECT", "", nil)
	req.Host = fmt.Sprintf("%s:%s", target, tport)
	req.Header.Set("Proxy-Authorization", auth)
	// For CONNECT the tunnel runs on the request stream: write tunnel bytes
	// to this pipe (request body), read responses from res.Body.
	pr, pw := io.Pipe()
	req.Body = pr
	res, err := cc.RoundTrip(req)
	if err != nil {
		fmt.Println("CONNECT RoundTrip error:", err)
		os.Exit(1)
	}
	defer res.Body.Close()
	fmt.Println("HTTP/2 CONNECT status:", res.Status)

	// Send a tiny HTTP/1.0 GET through the tunnel; on HTTP/1.1 this returns
	// data immediately, but over HTTP/2 the backend bytes never come back.
	if res.StatusCode == 200 {
		go func() {
			io.WriteString(pw, fmt.Sprintf("GET / HTTP/1.0\r\nHost: %s\r\n\r\n", target))
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		br := bufio.NewReader(res.Body)
		done := make(chan string, 1)
		go func() {
			buf := make([]byte, 128)
			n, _ := br.Read(buf)
			done <- fmt.Sprintf("read %d bytes: %q", n, string(buf[:n]))
		}()
		select {
		case r := <-done:
			fmt.Println("=== tunneled bytes ===")
			fmt.Println(r)
		case <-ctx.Done():
			fmt.Println("=== tunneled bytes ===")
			fmt.Println("timeout: no data relayed over HTTP/2 (connection still 200)")
		}
	}
	time.Sleep(500 * time.Millisecond)
}