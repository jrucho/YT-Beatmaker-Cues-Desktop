"""Compatibility entry point for packaging the current local macOS build."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
build = root / 'build-mac'
binary = build / 'BeatmakerCues_artefacts/Release/Standalone/Beatmaker Cues.app/Contents/MacOS/Beatmaker Cues'
architectures = set(subprocess.check_output(['lipo', '-archs', str(binary)], text=True).split())
arch = 'universal' if architectures == {'arm64', 'x86_64'} else 'arm64' if architectures == {'arm64'} else 'x64'
subprocess.run([sys.executable, str(root / 'Scripts/package_release.py'), '--build-dir', str(build), '--platform', 'macOS', '--arch', arch], check=True)
