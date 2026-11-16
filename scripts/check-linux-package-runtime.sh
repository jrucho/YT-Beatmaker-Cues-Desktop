#!/usr/bin/env bash
# CI-only: run inside a disposable Ubuntu container, never on the user's OS.
set -euo pipefail
package=${1:?package.deb required}
name=${2:?Debian package name required}
product=${3:?product name required}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends "$package" python3 xvfb xauth dbus-x11 openbox

# The test must not accidentally benefit from the build runner's dev symlinks.
for library in libwebkit2gtk-4.1 libjavascriptcoregtk-4.1 libsoup-3.0 libgtk-3 libglib-2.0; do
  if [ -e "/usr/lib/x86_64-linux-gnu/$library.so" ]; then
    echo "FAIL: development library unexpectedly installed: $library.so"
    exit 1
  fi
done
binary="/opt/$name/$product"
ldd "$binary"
test -f "/usr/lib/vst3/$product.vst3/Contents/x86_64-linux/$product.so"
export GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1
# Only for this headless CI container; these are not installed launcher settings.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
xvfb-run -a dbus-run-session -- sh -c 'openbox >/dev/null 2>&1 & sleep 1; exec "$@"' sh \
  python3 /checks/check-linux-standalone.py "$binary"
echo "PASS: installed Debian package runs with runtime dependencies only"
