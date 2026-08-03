// h1 - HTTP/1.1 CONNECT through the Envoy forward proxy.
//
// Demonstrates that HTTP/1.1 CONNECT both authenticates (returns 200 with a
// valid Proxy-Authorization) AND relays actual tunneled bytes (an HTTP/1.0
// GET sent over the tunnel returns the upstream response body).
//
// Build:   go build -o h1 .
// Run:
//   PROXY_HOST=170.9.16.247 PROXY_PORT=443 PROXY_AUTH=<base64(user:pass)> \
//       TARGET_HOST=example.com TARGET_PORT=80 ./h1
package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
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
	auth := envOr("PROXY_AUTH", "Basic dXV1OmNlNTNjeFZ1NzZma0RI") // uuu:ce53...
	target := envOr("TARGET_HOST", "example.com")
	tport := envOr("TARGET_PORT", "80")

	addr := fmt.Sprintf("%s:%s", host, port)
	conn, err := tls.Dial("tcp", addr, &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{"http/1.1"}, // force HTTP/1.1
	})
	if err != nil {
		fmt.Println("TLS dial error:", err)
		os.Exit(1)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(15 * time.Second))

	req := fmt.Sprintf("CONNECT %s:%s HTTP/1.1\r\nHost: %s:%s\r\nProxy-Authorization: %s\r\nProxy-Connection: keep-alive\r\n\r\n",
		target, tport, target, tport, auth)
	fmt.Fprint(conn, req)

	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		fmt.Println("read CONNECT reply error:", err)
		os.Exit(1)
	}
	fmt.Printf("HTTP/1.1 CONNECT status line: %q\n", strings.TrimSpace(line))
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			fmt.Println("reading headers error:", err)
			os.Exit(1)
		}
		if strings.TrimSpace(l) == "" {
			break
		}
	}
	if !strings.Contains(line, " 200 ") {
		fmt.Println("CONNECT not accepted (expected 200); tunnel aborted.")
		os.Exit(1)
	}

	// Send a tiny HTTP/1.0 GET through the tunnel; if bytes come back, the
	// proxy is truly relaying the tunnel (not just acking it).
	io.WriteString(conn, fmt.Sprintf("GET / HTTP/1.0\r\nHost: %s\r\n\r\n", target))
	buf := make([]byte, 128)
	n, err := io.ReadFull(br, buf)
	if err != nil && err != io.ErrUnexpectedEOF {
		fmt.Println("tunnel read error:", err)
		os.Exit(1)
	}
	fmt.Printf("=== tunneled bytes (%d) ===\n%s\n", n, string(buf[:n]))
	fmt.Println("RESULT: HTTP/1.1 CONNECT tunnels data =", n > 0)
}