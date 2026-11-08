"""Add verified Android/full-desktop builds to an existing native release.

Preserve the original tag and native binaries. Every asset records the source
that actually produced it; refreshed corresponding-source archives include the
new build baseline. This script stages files and never publishes or moves refs.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
parser = argparse.ArgumentParser()
parser.add_argument('--previous', default=f'release/github-v{version}')
parser.add_argument('--android', required=True)
parser.add_argument('--windows', required=True)
parser.add_argument('--mac', default='release')
parser.add_argument('--sources', required=True)
parser.add_argument('--output', default=f'release/github-v{version}-complete')
args = parser.parse_args()
previous, android, windows, mac, sources, output = [Path(getattr(args, name)).resolve()
    for name in ['previous', 'android', 'windows', 'mac', 'sources', 'output']]
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
tag = subprocess.check_output(['git', 'rev-parse', f'v{version}^{{commit}}'], cwd=root, text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise RuntimeError('Release staging requires clean committed source')
if output == mac or any(output == folder or output.is_relative_to(folder) for folder in [previous, android, windows, sources]):
    raise RuntimeError('Use a separate staging directory outside the input directories')

def digest(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()

checksum_name = f'SHA256SUMS-{version}.txt'
manifest_name = f'Release-Build-{version}.json'
baseline = set()
for line in (previous / checksum_name).read_text().splitlines():
    expected, name = line.split('  ', 1)
    if Path(name).name != name or name in baseline or digest(previous / name) != expected:
        raise RuntimeError(f'Invalid baseline checksum: {name}')
    baseline.add(name)
baseline.add(checksum_name)
if {file.name for file in previous.iterdir()} != baseline:
    raise RuntimeError('Baseline contains files outside its checksum inventory')
manifest = json.loads((previous / manifest_name).read_text())
if manifest.get('initialSourceCommit', manifest['sourceCommit']) != tag:
    raise RuntimeError('Baseline does not preserve the original release tag')
if {entry['name'] for entry in manifest['files']} != baseline - {manifest_name, checksum_name}:
    raise RuntimeError('Baseline inventory and checksums differ')
subprocess.run(['git', 'merge-base', '--is-ancestor', tag, sha], cwd=root, check=True)

records = [android / f'Plugin-Build-{version}-Android-arm64.json',
           mac / f'Main-Build-macOS-{version}.json',
           windows / f'Main-Build-Windows-{version}.json',
           sources / f'Source-Build-{version}.json']
builds = {}
for file in records:
    info = json.loads(file.read_text())
    if info.get('sourceCommit') != sha or info.get('workingTreeDirty') is not False or info.get('version') != version:
        raise RuntimeError(f'Build record is not from clean current source: {file}')
    builds[file.name] = info
android_record = builds[records[0].name]
if android_record.get('applicationId') != 'app.owaega.beatmakercuesstandalone' or android_record.get('signing') != 'persistent-release-key':
    raise RuntimeError('Expected the production Android app, not the internal probe')
if android_record.get('certificateSha256') != (root / 'mobile/android/release-certificate.sha256').read_text().strip():
    raise RuntimeError('Android update certificate changed')
if not {'native-touch', 'single-trigger', 'sample-pads', 'android-release-launch'} <= set(android_record.get('checks', [])):
    raise RuntimeError('Android build record is missing input/sample/release checks')
for platform in ['macOS', 'Windows']:
    if 'desktop-regression' not in builds[f'Main-Build-{platform}-{version}.json'].get('checks', []):
        raise RuntimeError(f'Missing full desktop regression check for {platform}')

additions = [android / f'Beatmaker-Cues-{version}-Android-arm64.apk',
             mac / f'YT-Beatmaker-Cues-Desktop-{version}-macOS-arm64.dmg',
             mac / f'YT-Beatmaker-Cues-Desktop-{version}-macOS-x64.dmg',
             windows / f'YT-Beatmaker-Cues-Desktop-{version}-Windows.exe']
replacements = [sources / name for name in [f'Beatmaker-Cues-Source-{version}.zip',
                f'Beatmaker-Cues-Source-{version}.tar.gz', f'Beatmaker-Cues-Plugin-Source-{version}.zip']]
inputs = additions + replacements + records
by_name = {file.name: file for file in inputs}
if len(by_name) != len(inputs):
    raise RuntimeError('Ambiguous new release inputs')
for platform in ['macOS', 'Windows']:
    record = builds[f'Main-Build-{platform}-{version}.json']
    for name, value in record['files'].items():
        if name not in by_name or digest(by_name[name]) != value['sha256']:
            raise RuntimeError(f'Installer differs from its build record: {name}')

def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or name.endswith(('.mobileprovision', '.jks', '.keystore', 'keystore.properties')):
        raise RuntimeError(f'Private/nonportable archive entry: {name}')

def check_source(info):
    if info.get('version') != version or info.get('sourceCommit') != sha:
        raise RuntimeError('Refreshed source archive identity mismatch')

for file in inputs:
    if not file.is_file() or file.stat().st_size == 0:
        raise RuntimeError(f'Missing new release asset: {file}')
    if file.suffix in ['.zip', '.apk']:
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None:
                raise RuntimeError(f'Corrupt archive: {file}')
            for name in archive.namelist():
                safe_name(name)
            if file.suffix == '.zip':
                names = [name for name in archive.namelist() if name.count('/') == 1 and name.endswith('/SOURCE-INFO.json')]
                if len(names) != 1:
                    raise RuntimeError(f'Missing source identity: {file}')
                check_source(json.loads(archive.read(names[0])))
    elif file.name.endswith('.tar.gz'):
        with tarfile.open(file) as archive:
            for member in archive.getmembers():
                safe_name(member.name)
            names = [member for member in archive.getmembers() if member.name.count('/') == 1 and member.name.endswith('/SOURCE-INFO.json')]
            if len(names) != 1:
                raise RuntimeError(f'Missing source identity: {file}')
            check_source(json.load(archive.extractfile(names[0])))
    elif file.suffix == '.exe':
        with file.open('rb') as stream:
            header = stream.read(64)
            if header[:2] != b'MZ':
                raise RuntimeError('Windows installer is not a PE executable')
            stream.seek(int.from_bytes(header[60:64], 'little'))
            if stream.read(4) != b'PE\0\0':
                raise RuntimeError('Windows installer has an invalid PE header')

output.mkdir(parents=True, exist_ok=True)
if any(output.iterdir()):
    raise RuntimeError('Use a new empty output directory')
for name in baseline:
    shutil.copy2(previous / name, output / name)
for file in inputs:
    shutil.copy2(file, output / file.name)
notes_name = f'Release-Notes-{version}.md'
shutil.copy2(root / 'docs' / f'release-{version}-notes.md', output / notes_name)
all_names = baseline | set(by_name)
updated = set(by_name) | {notes_name, manifest_name, checksum_name}
old_commits = manifest.get('assetSourceCommits', {})
commits = {name: sha if name in updated else old_commits.get(name, manifest['sourceCommit']) for name in all_names}
manifest['buildRecords'].update(builds)
manifest.update(sourceCommit=sha, initialSourceCommit=tag, workingTreeDirty=False,
                scope=['macOS', 'Windows', 'Android', 'iOS'], nativeOnly=False,
                fullDesktopStudio=['macOS-arm64', 'macOS-x64', 'Windows-x64'],
                expansion='Android maintenance and full desktop version-alignment builds',
                expandedPlatforms=['Android', 'full-desktop-studio'],
                updatedAssets=sorted(updated), retainedAssets=sorted(baseline - updated),
                assetSourceCommits=commits)
manifest['files'] = [{'name': name, 'bytes': (output / name).stat().st_size,
                      'sha256': digest(output / name), 'sourceCommit': commits[name]}
                     for name in sorted(all_names - {manifest_name, checksum_name})]
(output / manifest_name).write_text(json.dumps(manifest, indent=2) + '\n')
(output / checksum_name).write_text(''.join(f'{digest(output / name)}  {name}\n' for name in sorted(all_names - {checksum_name})))
print(f'Verified {len(all_names)} assets; retained native builds from {tag}, added builds from {sha}: {output}')
