"""Build the real mobile app UI with a local plug-in adapter (no repository edits)."""
from pathlib import Path
import os
import subprocess
import sys
import zipfile

plugin = Path(__file__).resolve().parent.parent
app = Path(sys.argv[1]).resolve()
desktop_beta = "--desktop-beta" in sys.argv[2:]
output = plugin / ("build-web-desktop-beta" if desktop_beta else "build-web")
environment = dict(os.environ, BEATMAKER_APP_SOURCE=str(app), BEATMAKER_PLUGIN_WEB_OUTPUT=str(output), BEATMAKER_DESKTOP_BETA="1" if desktop_beta else "0")
subprocess.run(["node", str(app / "web/node_modules/vite/bin/vite.js"), "build", "--mode", "native", "--config", str(plugin / "Web/vite.config.mts")], cwd=app / "web", env=environment, check=True)
destination = plugin / ("Assets/desktop-beta-ui.zip" if desktop_beta else "Assets/mobile-ui.zip")
with zipfile.ZipFile(destination, "w", zipfile.ZIP_STORED) as archive:
    for file in sorted(output.rglob("*"), key=lambda file: file.relative_to(output).as_posix()):
        if file.is_file():
            entry = zipfile.ZipInfo(file.relative_to(output).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            # Outer native packages compress this data. Stored entries avoid
            # platform/zlib-version differences in the committed UI archive.
            entry.compress_type = zipfile.ZIP_STORED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, file.read_bytes())
print("Packaged plug-in UI:", destination)
