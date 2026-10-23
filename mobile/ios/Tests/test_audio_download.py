"""Run with Xcode selected: python3 mobile/ios/Tests/test_audio_download.py."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import tempfile
import threading

PAYLOAD = bytes(range(251)) * (2_500_123 // 251) + bytes(range(251))[:2_500_123 % 251]
assert len(PAYLOAD) == 2_500_123


class Handler(BaseHTTPRequestHandler):
    retries = 0

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/retry" and Handler.retries < 1:
            Handler.retries += 1
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.path == "/http-error":
            self.send_response(403)
            data = b"Forbidden"
        elif self.path == "/whole":
            self.send_response(200)
            data = PAYLOAD
        else:
            start, end = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
            end = min(end, len(PAYLOAD) - 1)
            data = PAYLOAD[start:end + 1]
            self.send_response(206)
            reported_start = start + 1 if self.path == "/bad-range" else start
            self.send_header("Content-Range", f"bytes {reported_start}-{end}/{len(PAYLOAD)}")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    source = root / "App/App/AudioFileDownload.swift"
    if not source.exists():
        source = root / "App/AudioFileDownload.swift"  # Portable Xcode ZIP.
    with tempfile.TemporaryDirectory(prefix="beatmaker-download-tests-") as temporary:
        executable = str(Path(temporary) / "tests")
        subprocess.run(["xcrun", "swiftc", str(source),
                        str(root / "Tests/AudioFileDownloadTests.swift"), "-o", executable], check=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            subprocess.run([executable, f"http://127.0.0.1:{server.server_port}", temporary], check=True)
        finally:
            server.shutdown()
            server.server_close()
