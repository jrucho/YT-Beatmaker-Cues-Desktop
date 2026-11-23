"""Build the real mobile app UI with a local plug-in adapter (no repository edits)."""
import argparse
from pathlib import Path
import os
import subprocess
import zipfile

plugin = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("app", type=Path)
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--desktop-beta", action="store_true")
mode.add_argument("--ios-preview-dir", type=Path, help="Write the preview bundle here without replacing the shared ZIP")
args = parser.parse_args()
app = args.app.resolve()
desktop_beta = args.desktop_beta
preview = args.ios_preview_dir.resolve() if args.ios_preview_dir else None
output = preview / "web" if preview else plugin / ("build-web-desktop-beta" if desktop_beta else "build-web")
environment = dict(os.environ, BEATMAKER_APP_SOURCE=str(app), BEATMAKER_PLUGIN_WEB_OUTPUT=str(output), BEATMAKER_DESKTOP_BETA="1" if desktop_beta else "0")
subprocess.run(["node", str(app / "web/node_modules/vite/bin/vite.js"), "build", "--mode", "native", "--config", str(plugin / "Web/vite.config.mts")], cwd=app / "web", env=environment, check=True)
destination = preview / "mobile-ui.zip" if preview else plugin / ("Assets/desktop-beta-ui.zip" if desktop_beta else "Assets/mobile-ui.zip")
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
