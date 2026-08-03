"""h3 - HTTP/3 (QUIC) CONNECT through the Envoy forward proxy.

Reproduces the Envoy limitation: HTTP/3 CONNECT authenticates (returns 200
with a valid Proxy-Authorization) but does NOT relay tunneled bytes. After the
200 the QUIC server replies with zero DATA frames and terminates the
connection.

Important framing details:
  * For CONNECT over HTTP/3 the request MUST omit the :scheme and :path
    pseudo-headers (an empty :path triggers Envoy `http3.invalid_header_field`);
    only :method=CONNECT + :authority are sent.
  * HTTP/3 CONNECT requires the server to have `http3_protocol_options`
    (allow_extended_connect) on the QUIC listener.

Run:
  /tmp/h3venv/bin/python h3.py   (after: python3 -m venv; pip install aioquic)
or any python with aioquic installed, with env vars:
    PROXY_HOST=170.9.16.247 PROXY_PORT=443 PROXY_AUTH=... TARGET_HOST=example.com TARGET_PORT=80
"""
import asyncio
import os

from aioquic.asyncio.client import connect
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import DataReceived, HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ConnectionTerminated, StreamDataReceived

HOST = os.environ.get("H3_HOST", os.environ.get("PROXY_HOST", "170.9.16.247"))
PORT = int(os.environ.get("H3_PORT", os.environ.get("PROXY_PORT", "443")))
AUTH = os.environ.get("H3_AUTH", os.environ.get("PROXY_AUTH", "Basic dXV1OmNlNTNjeFZ1NzZma0RI"))
TARGET = os.environ.get("TARGET_HOST", "example.com")
TPORT = os.environ.get("TARGET_PORT", "80")


class Client(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.h3 = H3Connection(self._quic)
        self.status = None
        self.data = b""
        self.done = asyncio.Event()

    def quic_event_received(self, event):
        if isinstance(event, StreamDataReceived):
            print(f"  [quic] stream {event.stream_id} data_end={event.end_stream}")
            for h in self.h3.handle_event(event):
                if isinstance(h, HeadersReceived):
                    self.status = dict(h.headers).get(b":status")
                    print(f"  [h3] HEADERS status={self.status}")
                    if self.status != b"200":
                        self.done.set()
                elif isinstance(h, DataReceived):
                    self.data += h.data
                    print(f"  [h3] DATA(+{len(h.data)}): {h.data[:60]!r}")
        if isinstance(event, ConnectionTerminated):
            print(f"  [quic] ConnectionTerminated code={event.error_code} reason={event.reason_phrase!r}")
            self.done.set()


async def main():
    conf = QuicConfiguration(is_client=True, alpn_protocols=["h3"])
    conf.verify_mode = 0
    print(f"connecting to {HOST}:{PORT} via QUIC...")
    async with connect(HOST, PORT, configuration=conf, create_protocol=Client) as client:
        sid = client.h3._quic.get_next_available_stream_id()
        client.h3.send_headers(
            sid,
            [
                (b":method", b"CONNECT"),
                (b":authority", f"{TARGET}:{TPORT}".encode()),
                (b"proxy-authorization", AUTH.encode()),
            ],
            end_stream=False,
        )
        client.transmit()
        try:
            await asyncio.wait_for(client.done.wait(), timeout=10)
        except asyncio.TimeoutError:
            print("[h3] timeout waiting for response")

        if client.status == b"200":
            print("sending tunneled GET...")
            client.h3.send_data(
                sid,
                f"GET / HTTP/1.0\r\nHost: {TARGET}\r\n\r\n".encode(),
                end_stream=True,
            )
            client.transmit()
            client.done = asyncio.Event()
            try:
                await asyncio.wait_for(client.done.wait(), timeout=8)
            except asyncio.TimeoutError:
                print("  [h3] tunneled data timeout (no bytes relayed)")
        print(f"\n===== RESULT =====")
        print(f"HTTP/3 CONNECT status: {client.status}")
        print(f"HTTP/3 tunneled bytes received: {len(client.data)}")
        print("HTTP/3 CONNECT tunnels data =", bool(client.data))


asyncio.run(main())