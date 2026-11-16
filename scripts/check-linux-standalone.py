"""Require a real app-owned WebKit child and a working JavaScript/native bridge."""
from pathlib import Path
import argparse
import os
import re
import signal
import subprocess
import tempfile
import time


def webkit_children(pid):
    rows = subprocess.check_output(["ps", "-eo", "pid=,ppid=,args="], text=True)
    processes = {}
    for row in rows.splitlines():
        fields = row.strip().split(None, 2)
        if len(fields) == 3:
            processes[int(fields[0])] = (int(fields[1]), fields[2])
    result = []
    for child, (_, command) in processes.items():
        if not re.search(r"/WebKitWebProcess(?:\s|$)", command):
            continue
        parent, seen = child, set()
        while parent in processes and parent not in seen:
            if parent == pid:
                result.append((child, command))
                break
            seen.add(parent)
            parent = processes[parent][0]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="beatmaker-linux-startup-") as temporary:
        folder = Path(temporary)
        environment = dict(os.environ, BEATMAKER_PLUGIN_DATA_DIR=str(folder / "Library"),
                           BEATMAKER_SHARED_LIBRARY_DIR=str(folder / "Shared"),
                           BEATMAKER_AUDIO_CACHE_DIR=str(folder / "Cache"))
        log = folder / "standalone.log"
        with log.open("w") as output:
            process = subprocess.Popen([str(binary)], env=environment, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
        passed = False
        try:
            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline and process.poll() is None:
                children = webkit_children(process.pid)
                if children and "plug-in bridge started" in log.read_text(errors="replace"):
                    # Do not accept a transient child immediately followed by a crash.
                    time.sleep(1)
                    if process.poll() is None and webkit_children(process.pid):
                        for child, command in children:
                            print(f"standalone WebKit child {child}: {command}", flush=True)
                        passed = True
                    break
                time.sleep(0.25)
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
            print("\n".join(log.read_text(errors="replace").splitlines()[-60:]), flush=True)
        if not passed:
            raise SystemExit("FAIL: standalone did not retain its WebKit child and execute the JavaScript bridge")
        print("PASS: real Linux standalone WebKit child and JavaScript/native round-trip", flush=True)


if __name__ == "__main__":
    main()
