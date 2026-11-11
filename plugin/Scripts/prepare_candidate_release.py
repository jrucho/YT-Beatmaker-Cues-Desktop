"""Prepare checked public candidate assets from an immutable local checkpoint.

No repository commits, pushes or GitHub writes. iOS sanitization operates on an
extracted copy; the registered-device installation/archive remains intact.
"""
import argparse
import hashlib
import json
import plistlib
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--checkpoint', required=True)
parser.add_argument('--candidate', required=True, type=int)
parser.add_argument('--output', required=True)
parser.add_argument('--notes', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
checkpoint = Path(args.checkpoint).resolve()
record = json.loads((checkpoint / 'Checkpoint.json').read_text())
version = record['version']
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False)

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def checked_zip(file):
    with zipfile.ZipFile(file) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Corrupt candidate archive: ' + str(file))
        for name in archive.namelist():
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts:
                raise RuntimeError('Unsafe archive entry: ' + name)

# Check every candidate file against the saved source/app checkpoint before copying.
candidates = {}
for candidate in record['candidates']:
    source = root / candidate['path']
    for relative, expected in candidate['files'].items():
        file = source / relative if source.is_dir() else source
        if not file.is_file() or digest(file) != expected:
            raise RuntimeError('Candidate no longer matches the checkpoint: ' + str(file))
        candidates[file.name] = file

names = [f'Beatmaker-Cues-{version}-Android-arm64-development.apk',
         f'Plugin-Build-{version}-Android-arm64-development.json',
         f'Beatmaker-Cues-Plug-ins-{version}-macOS-universal.zip',
         f'Beatmaker-Cues-Plugin-Standalone-{version}-macOS-universal.zip',
         f'Plugin-Build-{version}-macOS-universal.json',
         f'Android-Feature-Port-{version}-Emulator-build-{args.candidate}.json']
for name in names:
    shutil.copy2(candidates[name], output / name)
    if name.endswith('.zip'):
        checked_zip(output / name)

# Keep the exact application/build source; omit only the local device-history notes.
source_zip = checkpoint / f'Source-{version}-development.zip'
checksum_lines = (checkpoint / 'SHA256SUMS.txt').read_text().splitlines()
expected = next(line.split('  ', 1)[0] for line in checksum_lines if line.endswith('  ' + source_zip.name))
if digest(source_zip) != expected:
    raise RuntimeError('Source snapshot checksum mismatch')
checked_zip(source_zip)
public_source = output / f'Beatmaker-Cues-Source-{version}-candidate-{args.candidate}.zip'
omitted = []
forbidden = {'.mobileprovision', '.jks', '.keystore', '.p12', '.p8', '.pem', '.key'}
with zipfile.ZipFile(source_zip) as original, zipfile.ZipFile(public_source, 'w', zipfile.ZIP_DEFLATED) as archive:
    for entry in original.infolist():
        path = PurePosixPath(entry.filename)
        if path.name == 'ios-feature-development.md':
            omitted.append(entry.filename)
            continue
        if path.suffix.lower() in forbidden or path.name.startswith('.env') or path.name == 'keystore.properties':
            raise RuntimeError('Private signing/configuration input in source: ' + entry.filename)
        data = original.read(entry)
        if b'-----BEGIN PRIVATE KEY-----' in data or b'-----BEGIN RSA PRIVATE KEY-----' in data or b'-----BEGIN OPENSSH PRIVATE KEY-----' in data:
            raise RuntimeError('Private key in source input: ' + entry.filename)
        archive.writestr(entry, data)
    archive.writestr('Beatmaker-Cues-Development/SOURCE-INFO.json', json.dumps({
        'version': version, 'candidate': args.candidate, 'sourceCommit': record['sourceCommit'],
        'workingTreeDirty': record['workingTreeDirty'], 'applicationSource': 'Checkpoint working-source snapshot',
        'snapshotSha256': digest(source_zip), 'omittedLocalNotes': omitted,
    }, indent=2) + '\n')
checked_zip(public_source)

signed_ipa = candidates[f'Beatmaker-Cues-{version}-iOS-development-signed.ipa']
unsigned_ipa = output / f'Beatmaker-Cues-{version}-iOS-unsigned.ipa'
checked_zip(signed_ipa)
with tempfile.TemporaryDirectory(prefix='beatmaker-public-ipa-', dir=output) as directory:
    stage = Path(directory)
    with zipfile.ZipFile(signed_ipa) as archive:
        archive.extractall(stage)
        for entry in archive.infolist():
            mode = (entry.external_attr >> 16) & 0o777
            file = stage / entry.filename
            if mode and file.is_file():
                file.chmod(mode)
    apps = list((stage / 'Payload').glob('*.app'))
    if len(apps) != 1:
        raise RuntimeError('Expected one real iOS container')
    app = apps[0]
    extensions = list((app / 'PlugIns').glob('*.appex'))
    if len(extensions) != 1:
        raise RuntimeError('Expected the embedded AUv3')
    expected_build = '.'.join(version.split('.')[:2]) + '.' + str(args.candidate)
    for bundle in [*extensions, app]:
        info = plistlib.loads((bundle / 'Info.plist').read_bytes())
        if info['CFBundleShortVersionString'] != version or info['CFBundleVersion'] != expected_build:
            raise RuntimeError('Unexpected iOS version/build in ' + str(bundle))
        if 'arm64' not in subprocess.check_output(['lipo', '-archs', str(bundle / info['CFBundleExecutable'])], text=True).split():
            raise RuntimeError('Missing arm64 iOS executable')
        subprocess.run(['codesign', '--remove-signature', str(bundle)], check=True)
        if subprocess.run(['codesign', '--verify', str(bundle)], capture_output=True).returncode == 0:
            raise RuntimeError('Expected a genuinely unsigned public iOS executable')
    for file in app.rglob('embedded.mobileprovision'):
        file.unlink()
    for directory in list(app.rglob('_CodeSignature')):
        shutil.rmtree(directory)
    with zipfile.ZipFile(unsigned_ipa, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(stage.rglob('*')):
            if file.is_file():
                archive.write(file, file.relative_to(stage).as_posix())
checked_zip(unsigned_ipa)
with zipfile.ZipFile(unsigned_ipa) as archive:
    if any('embedded.mobileprovision' in name or '_CodeSignature/' in name for name in archive.namelist()):
        raise RuntimeError('Public iOS package still contains personal provisioning/signatures')

shutil.copy2(Path(args.notes), output / f'Release-Notes-{version}-candidate-{args.candidate}.md')
build = output / f'Candidate-Build-{version}-{args.candidate}.json'
build.write_text(json.dumps({
    'version': version, 'candidate': args.candidate, 'releaseType': 'prerelease',
    'sourceCommit': record['sourceCommit'], 'workingTreeDirty': record['workingTreeDirty'],
    'correspondingSource': public_source.name, 'sourceSnapshotSha256': digest(source_zip),
    'ios': {'build': expected_build, 'signing': 'unsigned', 'extensionEmbedded': True,
            'originalDevelopmentIpaSha256': digest(signed_ipa), 'personalProvisioningIncluded': False},
    'android': {'applicationId': 'app.owaega.beatmakercuesstandalone.development', 'signing': 'debug-development-key'},
    'macOS': {'architecture': 'universal', 'formats': ['VST3', 'AU', 'Standalone'], 'signing': 'ad-hoc'},
    'files': {file.name: {'sha256': digest(file), 'bytes': file.stat().st_size} for file in sorted(output.iterdir()) if file.is_file()},
}, indent=2) + '\n')
manifest = output / f'SHA256SUMS-Candidate-{version}-{args.candidate}.txt'
manifest.write_text(''.join(digest(file) + '  ' + file.name + '\n' for file in sorted(output.iterdir()) if file.is_file() and file != manifest))
print(json.dumps({'result': 'PASS', 'output': str(output), 'version': version, 'candidate': args.candidate,
                  'files': [file.name for file in sorted(output.iterdir())]}, indent=2))
