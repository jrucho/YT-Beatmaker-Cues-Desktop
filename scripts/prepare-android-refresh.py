"""Stage an Android/source refresh, preserving other published assets and tag.

This verifies clean-source inputs and the checksum-listed baseline, writes
per-asset provenance, and never publishes or changes git refs.
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
parser.add_argument('--android', default=f'release/android-{version}-latency')
parser.add_argument('--sources', default=f'release/source-{version}-android-latency')
parser.add_argument('--output', default=f'release/github-v{version}-android-latency')
args = parser.parse_args()
previous, android, sources, output = [Path(value).resolve() for value in
                                      [args.previous, args.android, args.sources, args.output]]
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
tag = subprocess.check_output(['git', 'rev-parse', f'v{version}^{{commit}}'], cwd=root, text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise RuntimeError('Commit/review the refresh source before staging')
if output in [previous, android, sources] or any(output.is_relative_to(folder) for folder in [previous, android, sources]):
    raise RuntimeError('Use a separate refresh output folder')


def digest(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def verify_checksums(folder, filename):
    names = set()
    for line in (folder / filename).read_text().splitlines():
        expected, name = line.split('  ', 1)
        if Path(name).name != name or name in names or digest(folder / name) != expected:
            raise RuntimeError(f'Checksum mismatch or unsafe/duplicate name: {folder / name}')
        names.add(name)
    return names | {filename}


def current_info(info, archive=False):
    if info.get('sourceCommit') != sha or (not archive and info.get('workingTreeDirty') is not False):
        raise RuntimeError('Refreshed assets require clean current-source metadata')
    if info.get('version') != version:
        raise RuntimeError('Refreshed asset version mismatch')


def safe_name(name):
    parts = PurePosixPath(name).parts
    if name.startswith('/') or '..' in parts or name.endswith(('.jks', '.keystore', '.mobileprovision', 'keystore.properties')):
        raise RuntimeError(f'Private/nonportable archive entry: {name}')


manifest_name, checksum_name = f'Release-Build-{version}.json', f'SHA256SUMS-{version}.txt'
baseline = verify_checksums(previous, checksum_name)
manifest = json.loads((previous / manifest_name).read_text())
if manifest.get('initialSourceCommit', manifest['sourceCommit']) != tag:
    raise RuntimeError('Baseline must identify the original published tag')
if {entry['name'] for entry in manifest['files']} != baseline - {manifest_name, checksum_name}:
    raise RuntimeError('Baseline inventory and checksums differ')
verify_checksums(android, f'SHA256SUMS-Plugins-{version}-Android-arm64.txt')
verify_checksums(sources, f'SHA256SUMS-Source-{version}.txt')
replacements = [android / f'Beatmaker-Cues-{version}-Android-arm64.apk',
                android / f'Plugin-Build-{version}-Android-arm64.json']
replacements += [sources / name for name in [f'Beatmaker-Cues-Source-{version}.zip',
                 f'Beatmaker-Cues-Source-{version}.tar.gz', f'Beatmaker-Cues-Plugin-Source-{version}.zip',
                 f'Source-Build-{version}.json']]
for file in replacements:
    if file.name not in baseline:
        raise RuntimeError(f'Refreshed asset is absent from the published inventory: {file.name}')
    if file.suffix == '.json':
        info = json.loads(file.read_text())
        current_info(info)
        manifest['buildRecords'][file.name] = info
    elif file.suffix in ['.zip', '.apk']:
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None:
                raise RuntimeError(f'Corrupt ZIP/APK: {file}')
            for name in archive.namelist():
                safe_name(name)
            if file.suffix == '.zip':
                records = [name for name in archive.namelist() if name.count('/') == 1 and name.endswith('/SOURCE-INFO.json')]
                if len(records) != 1:
                    raise RuntimeError(f'Missing unambiguous source identity: {file}')
                current_info(json.loads(archive.read(records[0])), archive=True)
    elif file.name.endswith('.tar.gz'):
        with tarfile.open(file) as archive:
            for entry in archive.getmembers():
                safe_name(entry.name)
            records = [entry for entry in archive.getmembers() if entry.name.count('/') == 1 and entry.name.endswith('/SOURCE-INFO.json')]
            if len(records) != 1:
                raise RuntimeError(f'Missing source identity: {file}')
            current_info(json.load(archive.extractfile(records[0])), archive=True)

android_info = manifest['buildRecords'][f'Plugin-Build-{version}-Android-arm64.json']
if android_info.get('applicationId') != 'app.owaega.beatmakercuesstandalone' or android_info.get('signing') != 'persistent-release-key':
    raise RuntimeError('Expected the signed normal application, not the latency probe')
if not {'native-touch', 'single-trigger', 'sample-pads', 'screen-off-next-track'} <= set(android_info['checks']):
    raise RuntimeError('Missing Android input/sample/background verification records')
measurements = [entry['result'] for entry in android_info.get('latencyMeasurements', [])]
for mode in ['original-ui', 'native-touch']:
    for stall in [0, 1500]:
        if not any(result.get('mode') == mode and result.get('rendererStallMs') == stall
                   and result.get('requestedBursts') == 2 and result.get('xrunDelta') == 0
                   for result in measurements):
            raise RuntimeError('Missing stable two-burst Android input comparison reports')
expected_certificate = (root / 'mobile/android/release-certificate.sha256').read_text().strip().lower()
if android_info.get('certificateSha256') != expected_certificate:
    raise RuntimeError('Android release certificate mismatch')
if 'selected-bank-residency' in android_info['checks']:
    baseline_result = android_info.get('cueResidencyBaseline', {}).get('result', {})
    if baseline_result.get('coldHits', 0) <= 0:
        raise RuntimeError('Missing the measured later-bank cache baseline')
    residency = android_info.get('cueResidencyMeasurements', [])
    for speed, tuning in [(0, 0), (50, 5), (-50, -7)]:
        if not any(entry.get('sourceCommit') == sha and entry['result'].get('speed') == speed
                   and entry['result'].get('tuning') == tuning and entry['result'].get('coldHits') == 0
                   and entry['result'].get('xrunDelta') == 0
                   and entry['result'].get('prefetch', {}).get('readyCueHeads') == 16
                   and entry['result'].get('prefetch', {}).get('pcmCacheBytes') == 16 * 1024 * 1024
                   for entry in residency):
            raise RuntimeError('Missing current-source prepared-bank speed/tuning verification')
if 'physical-speaker' in android_info['checks']:
    physical = android_info.get('deviceLatency', {}).get('measurements', [])
    for speed, tuning in [(0, 0), (50, 5), (-50, -7)]:
        if not any(entry.get('sourceCommit') == sha and entry['result'].get('device', {}).get('emulator') is False
                   and entry['result'].get('dsp', {}).get('speed') == speed
                   and entry['result'].get('dsp', {}).get('tuning') == tuning
                   and entry['result'].get('xrunDelta') == 0
                   and entry['result'].get('platformAfter', {}).get('output', {}).get('performance') == 12
                   and entry['result'].get('platformAfter', {}).get('output', {}).get('format') == 2
                   for entry in physical):
            raise RuntimeError('Missing current-source physical float-output speed/tuning verification')

output.mkdir(parents=True, exist_ok=True)
if any(output.iterdir()):
    raise RuntimeError('Use a new empty refresh output folder')
for name in sorted(baseline):
    shutil.copy2(previous / name, output / name)
for file in replacements:
    shutil.copy2(file, output / file.name)
notes_name = f'Release-Notes-{version}.md'
shutil.copy2(root / 'docs' / f'release-{version}-notes.md', output / notes_name)
updated = {file.name for file in replacements} | {notes_name, manifest_name, checksum_name}
old_commits = manifest.get('assetSourceCommits', {})
commits = {name: sha if name in updated else old_commits.get(name, manifest['sourceCommit']) for name in baseline}
manifest.update(sourceCommit=sha, initialSourceCommit=tag, workingTreeDirty=False,
                refresh='Android native touch, selected-bank residency and accepted-stream adaptive buffering',
                refreshScope=['Android', 'corresponding-source'], refreshedAssets=sorted(updated),
                retainedAssets=sorted(baseline - updated), assetSourceCommits=commits)
manifest['files'] = [{'name': name, 'bytes': (output / name).stat().st_size,
                      'sha256': digest(output / name), 'sourceCommit': commits[name]}
                     for name in sorted(baseline - {manifest_name, checksum_name})]
(output / manifest_name).write_text(json.dumps(manifest, indent=2) + '\n')
(output / checksum_name).write_text(''.join(f'{digest(output / name)}  {name}\n'
                                           for name in sorted(baseline - {checksum_name})))
verify_checksums(output, checksum_name)
print(f'Verified {len(updated)} refreshed assets and {len(baseline - updated)} retained assets: {output}')
