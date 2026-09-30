#!/usr/bin/env python3
"""Secret-free HTTP worker for compiling one untrusted PlatformIO project."""
import base64
import http.server
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath

PORT = int(os.environ.get("PORT", "8123"))
TIMEOUT_SECONDS = int(os.environ.get("BUILD_TIMEOUT_SECONDS", "1200"))
MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
MAX_FILES = 800
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
active_process = None


def emit(handler, event):
    payload = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    handler.wfile.write(f"{len(payload):X}\r\n".encode() + payload + b"\r\n")
    handler.wfile.flush()


def extract_project(archive_path, workspace):
    total = 0
    count = 0
    with tarfile.open(archive_path, "r:") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
                raise ValueError("project archive contains an unsafe path")
            if not member.isfile():
                raise ValueError("project archive contains a non-regular entry")
            if member.size > MAX_FILE_BYTES:
                raise ValueError("project file exceeds the configured size limit")
            count += 1
            total += member.size
            if count > MAX_FILES or total > MAX_TOTAL_BYTES:
                raise ValueError("project exceeds the configured archive limits")
            destination = workspace.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("project archive contains an unreadable file")
            with destination.open("xb") as target:
                shutil.copyfileobj(source, target, 64 * 1024)
    if (workspace / "platformio.ini").is_file():
        root = workspace
    else:
        candidates = [child for child in workspace.iterdir() if child.is_dir() and (child / "platformio.ini").is_file()]
        if len(candidates) != 1:
            raise ValueError("no unambiguous platformio.ini in the uploaded project")
        root = candidates[0]
    config = (root / "platformio.ini").read_text(encoding="utf-8")
    if "[env:tmflash]" not in config:
        raise ValueError("the project has no [env:tmflash] environment")
    return root


def stream_build(handler, project):
    global active_process
    executable = shutil.which("pio")
    if not executable:
        raise RuntimeError("PlatformIO is missing from the isolated worker image")
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": "/tmp/home",
        "PLATFORMIO_CORE_DIR": "/tmp/.platformio",
        "PLATFORMIO_NO_ANSI": "true",
        "PLATFORMIO_RUN_JOBS": "1",
        "NO_COLOR": "1",
        "PYTHONUNBUFFERED": "1",
    }
    process = subprocess.Popen(
        [executable, "run", "-e", "tmflash", "-d", str(project)],
        cwd=project,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    active_process = process
    output = []
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    buffer = b""
    timed_out = False
    try:
        while process.poll() is None or selector.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                stop_process(process)
                break
            for key, _ in selector.select(timeout=0.25):
                chunk = os.read(key.fd, 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer += chunk
                lines = buffer.split(b"\n")
                buffer = lines.pop()
                for raw_line in lines:
                    send_log(handler, raw_line, output)
        if buffer.strip():
            send_log(handler, buffer, output)
        code = process.wait(timeout=2)
    except (BrokenPipeError, ConnectionResetError):
        stop_process(process)
        raise
    finally:
        selector.close()
        active_process = None
    if timed_out:
        code = 124
        send_log(handler, b"build timed out", output)
    artifact = None
    if code == 0:
        artifact = read_artifact(project)
    emit(handler, {"type": "result", "exitCode": code, "artifactBase64": base64.b64encode(artifact).decode() if artifact else None})


def send_log(handler, raw_line, output):
    line = raw_line.decode("utf-8", errors="replace").strip()[:8192]
    if not line:
        return
    output.append(line)
    if len(output) > 400:
        del output[0]
    emit(handler, {"type": "log", "line": line})


def read_artifact(project):
    root = project.resolve()
    artifact = project / ".pio" / "build" / "tmflash" / "firmware.bin"
    if artifact.is_symlink() or not artifact.is_file() or os.path.commonpath((root, artifact.resolve())) != str(root):
        raise RuntimeError("the build produced no safe firmware.bin")
    data = artifact.read_bytes()
    if not data or len(data) > MAX_ARTIFACT_BYTES:
        raise RuntimeError("the build image size is outside the allowed range")
    return data


def stop_process(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path != "/healthz":
            self.send_error(404)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/build":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length <= 0 or length > MAX_ARCHIVE_BYTES:
            self.send_error(413)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        job_dir = Path(tempfile.mkdtemp(prefix="job-", dir="/workspace"))
        archive_path = None
        try:
            archive_path = Path(tempfile.mkstemp(prefix="project-", suffix=".tar", dir="/tmp")[1])
            with archive_path.open("wb") as archive:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        raise ValueError("project upload ended early")
                    archive.write(chunk)
                    remaining -= len(chunk)
            project = extract_project(archive_path, job_dir)
            archive_path.unlink(missing_ok=True)
            stream_build(self, project)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            try:
                emit(self, {"type": "log", "line": str(error)[:8192]})
                emit(self, {"type": "result", "exitCode": 1, "artifactBase64": None})
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            if archive_path is not None:
                archive_path.unlink(missing_ok=True)
            shutil.rmtree(job_dir, ignore_errors=True)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            threading.Thread(target=server.shutdown, daemon=True).start()

    def log_message(self, _format, *_args):
        return


def shutdown(_signum, _frame):
    if active_process is not None:
        stop_process(active_process)
    raise SystemExit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)
server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
server.serve_forever(poll_interval=0.5)
server.server_close()
os._exit(0)
