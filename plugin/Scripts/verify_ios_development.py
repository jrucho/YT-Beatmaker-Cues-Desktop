"""Finish an already installed/restored update after a locked-device launch."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import time
from urllib.parse import unquote, urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--app', required=True)
parser.add_argument('--installation', required=True)
args = parser.parse_args()
root = Path(args.installation).resolve()
app = Path(args.app).resolve()
info = plistlib.loads((app / 'Info.plist').read_bytes())
bundle = info['CFBundleIdentifier']
before = json.loads((root / 'Before.json').read_text())
if bundle != before['bundleIdentifier'] or info.get('CFBundleDisplayName') != 'Beatmaker Cues':
    raise RuntimeError('The app must match the backed-up installed identity')
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)

def run(arguments):
    result = subprocess.run(['/usr/bin/xcrun', 'devicectl', 'device', *arguments[:2], '--device', args.device,
                             '--timeout', '60', *arguments[2:], '--json-output', '-'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout or 'CoreDevice failed')
    document = json.loads(result.stdout)
    if document['info']['outcome'] != 'success':
        raise RuntimeError('CoreDevice did not report success')
    return document['result']

files = [file for file in (root / 'Restore/Library/Beatmaker Cues').rglob('*') if file.is_file()]
if not files:
    raise RuntimeError('The restored saved-data copy is missing')
relocated = []
for file in files:
    relative = file.relative_to(root / 'Restore')
    received = root / 'Readback' / relative
    if not received.is_file() or hashlib.sha256(file.read_bytes()).digest() != hashlib.sha256(received.read_bytes()).digest():
        raise RuntimeError('Restored data mismatch: ' + str(relative))
    if (root / 'Before' / relative).read_bytes() != file.read_bytes():
        relocated.append(str(relative))

metadata = run(['info', 'apps', '--bundle-id', bundle, '--include-container-paths'])['apps'][0]
if metadata['version'] != info['CFBundleShortVersionString'] or metadata['bundleVersion'] != info['CFBundleVersion'] or metadata['name'] != 'Beatmaker Cues':
    raise RuntimeError('Installed app identity/version mismatch')
executable = unquote(urlparse(metadata['url']).path).rstrip('/') + '/' + info['CFBundleExecutable']
running = [row for row in run(['info', 'processes'])['runningProcesses']
           if unquote(urlparse(row.get('executable', '')).path) == executable]
pid = running[0]['processIdentifier'] if running else run(['process', 'launch', bundle])['process']['processIdentifier']
time.sleep(2)
if not any(row['processIdentifier'] == pid for row in run(['info', 'processes'])['runningProcesses']):
    raise RuntimeError('Updated app exited during startup')

folder = root / 'Restore/Library/Beatmaker Cues/PluginLibrary'
library = json.loads((folder / 'library-v1.json').read_text())['library']
session = json.loads((folder / 'Sessions/standalone.json').read_text())
cues = json.loads(session.get('musike:cues:v1', '{}'))
samples = json.loads((folder / 'PadSamples/standalone.json').read_text())
profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
report = {'result': 'PASS', 'version': metadata['version'], 'build': metadata['bundleVersion'],
          'displayName': metadata['name'], 'app': bundle, 'sourceApp': before['bundleIdentifier'],
          'previousVersion': before['version'], 'previousBuild': before['bundleVersion'],
          'previousDataBackupRetained': True, 'verifiedFiles': len(files), 'relocatedFiles': relocated,
          'playlists': len(library.get('playlists', [])), 'samplePads': len(samples),
          'cueMarks': sum(len(pads) for banks in cues.values() for pads in banks.values()),
          'audioDevicePreferences': 'retained by the in-place update; not rewritten through CoreDevice',
          'launchRecovery': 'Completed launch verification after the initial installer launch failed',
          'processIdentifier': pid, 'profileExpiresUTC': profile['ExpirationDate'].isoformat() + 'Z'}
(root / 'Installation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
