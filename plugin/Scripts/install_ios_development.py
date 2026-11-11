"""Update the iPhone development app with backed-up and relocated saved data.

Backups and a full file readback are retained under the explicit local backup
directory. The app keeps its normal installed name and registered identity.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time
from urllib.parse import unquote, urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--app', required=True)
parser.add_argument('--bundle-id', required=True)
parser.add_argument('--backup-dir', required=True)
parser.add_argument('--skip-device-preferences', action='store_true', help='Skip the optional audio-device settings transfer; iOS retains it during the in-place update')
args = parser.parse_args()
app = Path(args.app).resolve()
info = plistlib.loads((app / 'Info.plist').read_bytes())
target_id = info['CFBundleIdentifier']
if target_id != args.bundle_id:
    raise RuntimeError('The update must match the explicitly selected installed app ID')
if info.get('CFBundleDisplayName') != 'Beatmaker Cues':
    raise RuntimeError('The installed app name must remain Beatmaker Cues')
backup = Path(args.backup_dir).resolve()
backup.mkdir(parents=True, exist_ok=False)

def command(arguments, structured=False):
    values = ['/usr/bin/xcrun', 'devicectl', 'device', *arguments[:2], '--device', args.device, '--timeout', '120', *arguments[2:]]
    if structured:
        result = subprocess.run([*values, '--json-output', '-'], check=True, text=True, capture_output=True)
        data = json.loads(result.stdout)
        if data.get('info', {}).get('outcome') != 'success':
            raise RuntimeError('CoreDevice did not report success')
        return data['result']
    subprocess.run(values, check=True)

def installed(bundle):
    rows = command(['info', 'apps', '--bundle-id', bundle, '--include-container-paths'], True)['apps']
    return rows[0] if rows else None

def stop_app(metadata):
    if not metadata:
        return
    prefix = metadata['bundleContainerPath'].rstrip('/') + '/'
    processes = command(['info', 'processes'], True)['runningProcesses']
    for process in processes:
        executable = unquote(urlparse(process.get('executable', '')).path)
        if executable.startswith(prefix):
            command(['process', 'terminate', '--pid', str(process['processIdentifier'])])

def transfer(direction, bundle, source, destination):
    if direction == 'from':
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
    command(['copy', direction, '--domain-type', 'appDataContainer', '--domain-identifier', bundle,
             '--source', str(source), '--destination', str(destination)])

subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
source = installed(target_id)
if not source:
    raise RuntimeError('The existing development app must be installed before updating')
stop_app(source)
source_id = source['bundleIdentifier']
(backup / 'Before.json').write_text(json.dumps(source, indent=2) + '\n')
for relative in ['Library/Beatmaker Cues'] + ([] if args.skip_device_preferences else ['Library/Application Support/Beatmaker Cues Plug-in.settings']):
    try:
        transfer('from', source_id, relative, backup / 'Before' / relative)
    except subprocess.CalledProcessError:
        if relative != 'Library/Application Support/Beatmaker Cues Plug-in.settings':
            raise

def json_document(folder, relative):
    return json.loads((folder / relative).read_text(encoding='utf-8'))

native_relative = Path('Library/Beatmaker Cues/PluginLibrary')
before_library = backup / 'Before' / native_relative
# Validate the complete saved session before touching the test installation.
for file in before_library.rglob('*'):
    if file.is_file() and file.name.endswith(('.json', '.json.backup')):
        json.loads(file.read_text(encoding='utf-8'))

command(['install', 'app', str(app)])
after = installed(target_id)
if not after or after['version'] != info['CFBundleShortVersionString']:
    raise RuntimeError('The installed test version does not match the signed app')
stop_app(after)
old = source['dataContainerPath'].removeprefix('/private').rstrip('/')
new = after['dataContainerPath'].removeprefix('/private').rstrip('/')
restore = backup / 'Restore'
shutil.copytree(backup / 'Before', restore, ignore=shutil.ignore_patterns('library.lock'))
changed = []
files = [file for file in (restore / native_relative).rglob('*') if file.is_file()]
for file in files:
    if file.name.endswith(('.json', '.json.backup', '.settings')):
        text = file.read_text(encoding='utf-8')
        updated = text.replace('/private' + old, '/private' + new).replace(old, new)
        if updated != text:
            if file.name.endswith(('.json', '.json.backup')):
                json.loads(updated)
            file.write_text(updated, encoding='utf-8')
            changed.append(str(file.relative_to(restore)))
    os.utime(file, None)

restored_library = restore / native_relative
pads = json_document(restored_library, 'PadSamples/standalone.json')
for pad in pads:
    path = pad['path'].removeprefix('/private')
    if not path.startswith(new + '/') or not (restore / path[len(new) + 1:]).is_file():
        raise RuntimeError('A sample assignment has no retained file in the test copy')
for relative in ['Library/Beatmaker Cues']:
    transfer('to', target_id, restore / relative, relative)
for relative in ['Library/Beatmaker Cues']:
    transfer('from', target_id, relative, backup / 'Readback' / relative)
for file in files:
    received = backup / 'Readback' / file.relative_to(restore)
    if not received.is_file() or hashlib.sha256(file.read_bytes()).digest() != hashlib.sha256(received.read_bytes()).digest():
        raise RuntimeError('The test copy failed saved-data readback: ' + str(file.relative_to(restore)))

launch = command(['process', 'launch', '--terminate-existing', target_id], True)
time.sleep(2)
verified = installed(target_id)
if not verified or verified['version'] != info['CFBundleShortVersionString'] or verified['name'] != 'Beatmaker Cues':
    raise RuntimeError('The installed update version/name is incorrect')
running = command(['info', 'processes'], True)['runningProcesses']
if not any(process['processIdentifier'] == launch['process']['processIdentifier'] for process in running):
    raise RuntimeError('The updated app exited during startup')
profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
session = json_document(restored_library, 'Sessions/standalone.json')
cues = json.loads(session.get('musike:cues:v1', '{}'))
library = json_document(restored_library, 'library-v1.json').get('library', {})
report = {'result': 'PASS', 'version': after['version'], 'build': after.get('bundleVersion'), 'displayName': after['name'],
          'app': target_id, 'sourceApp': source_id, 'previousVersion': source['version'],
          'previousDataBackupRetained': True,
          'audioDevicePreferences': 'retained by the in-place app update; not rewritten through CoreDevice',
          'verifiedFiles': len(files), 'relocatedFiles': changed,
          'playlists': len(library.get('playlists', [])), 'samplePads': len(pads),
          'cueMarks': sum(len(marks) for banks in cues.values() for marks in banks.values()),
          'processIdentifier': launch['process']['processIdentifier'],
          'profileExpiresUTC': profile['ExpirationDate'].isoformat() + 'Z'}
(backup / 'Installation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
