#!/usr/bin/env bash
# Run the real WebView/native-audio smoke test inside the virtual X server.
# A plain failure is retried under strace so a startup deadlock in the GTK or
# WebKit child process can be located from CI logs without another rebuild.
set -u

binary=${1:?usage: run-linux-webview-smoke.sh BINARY [ARG...]}
shift

echo "== Linux WebView smoke environment =="
uname -srm
echo "DISPLAY=${DISPLAY:-} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-} DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}"
if command -v dpkg-query >/dev/null 2>&1; then
  dpkg-query -W -f='libwebkit2gtk-4.1-0=${Version}\n' libwebkit2gtk-4.1-0 2>/dev/null || true
fi
ldd "$binary" | grep -Ei 'webkit|javascriptcore|gtk-3|soup' || true

echo "== WebView smoke test =="
timeout --kill-after=10s 300s "$binary" "$@"
status=$?
if [ "$status" -eq 0 ]; then
  echo "== WebView smoke test passed =="
  exit 0
fi

# Keep diagnostics in a collapsible group; strace output can be large.
echo "::group::WebView smoke test diagnostics (status $status)"
echo "== processes =="
ps -eo pid,ppid,pgid,stat,etime,comm,args | tail -n 60
if command -v strace >/dev/null 2>&1; then
  trace_file=$(mktemp -t beatmaker-webview-XXXXXX.strace)
  echo "== rerunning under strace; trace: $trace_file =="
  timeout --kill-after=10s 240s strace -f -tt -y -s 160 \
    -e trace=%process,read,write,poll,ppoll,select,connect,openat \
    -o "$trace_file" "$binary" "$@" || true
  echo "== last 200 trace events =="
  tail -n 200 "$trace_file"
  echo "== last WebView startup markers =="
  grep -a '\[webview\]' "$trace_file" | tail -n 40 || true
fi
echo "::endgroup::"
exit "$status"
