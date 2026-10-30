"""Stage the verified Mac/Windows/Android/iOS release, without publishing it.

The historical complete-matrix assembler also requires Linux/beta/legacy apps.
This inventory follows the current product lineup, includes both native standalone
apps and full desktop studios, and requires one clean committed source baseline.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
parser = argparse.ArgumentParser()
parser.add_argument('--delivery', default=f'release/Beatmaker-Cues-Local-Delivery-{version}')
parser.add_argument('--windows', required=True, help='Downloaded Windows CI artifacts, merged into one directory')
parser.add_argument('--sources', default=f'release/source-{version}')
parser.add_argument('--output', default=f'release/github-v{version}')
args = parser.parse_args()
delivery, windows, sources, output = [Path(value).resolve() for value in [args.delivery, args.windows, args.sources, args.output]]
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise RuntimeError('Public release staging requires a clean committed source tree')

records = [
    delivery / 'Android' / f'Plugin-Build-{version}-Android-arm64.json',
    delivery / 'macOS/Native-Plugins' / f'Plugin-Build-{version}-macOS-universal.json',
    windows / f'Plugin-Build-{version}-Windows-x64.json',
    delivery / 'iOS/Unsigned' / f'AUv3-Build-{version}.json',
    root / 'release' / f'Main-Build-macOS-{version}.json',
    windows / f'Main-Build-Windows-{version}.json',
    sources / f'Source-Build-{version}.json',
]
builds = {}
for file in records:
    value = json.loads(file.read_text())
    if value['sourceCommit'] != sha or value.get('workingTreeDirty') is not False or value['version'] != version:
        raise RuntimeError(f'{file}: expected clean source {sha}, got {value}')
    builds[file.name] = value
if builds[f'AUv3-Build-{version}.json']['signing'] != 'unsigned':
    raise RuntimeError('The public iOS export must be unsigned')

assets = [
    delivery / 'Android' / f'Beatmaker-Cues-{version}-Android-arm64.apk',
    delivery / 'macOS/Native-Plugins' / f'Beatmaker-Cues-Plug-ins-{version}-macOS-universal.zip',
    delivery / 'macOS/Native-Plugins' / f'Beatmaker-Cues-Plugin-Standalone-{version}-macOS-universal.zip',
    windows / f'Beatmaker-Cues-Plug-ins-{version}-Windows-x64.zip',
    windows / f'Beatmaker-Cues-Plugin-Standalone-{version}-Windows-x64.zip',
    delivery / 'iOS/Unsigned' / f'Beatmaker-Cues-{version}-iOS-unsigned.ipa',
    delivery / 'iOS/Xcode' / f'Beatmaker-Cues-Plugin-Xcode-{version}.zip',
    delivery / 'macOS/Xcode' / f'Beatmaker-Cues-Plugin-Xcode-{version}-macOS.zip',
    root / 'release' / f'YT-Beatmaker-Cues-Desktop-{version}-macOS-arm64.dmg',
    root / 'release' / f'YT-Beatmaker-Cues-Desktop-{version}-macOS-x64.dmg',
    windows / f'YT-Beatmaker-Cues-Desktop-{version}-Windows.exe',
    sources / f'Beatmaker-Cues-Source-{version}.zip',
    sources / f'Beatmaker-Cues-Source-{version}.tar.gz',
    sources / f'Beatmaker-Cues-Plugin-Source-{version}.zip',
]
native_expectations = {
    f'Beatmaker-Cues-Plugin-Standalone-{version}-macOS-universal.zip': 'Beatmaker-Cues-Standalone/Beatmaker Cues.app/Contents/MacOS/Beatmaker Cues',
    f'Beatmaker-Cues-Plugin-Standalone-{version}-Windows-x64.zip': 'Beatmaker-Cues-Standalone/Beatmaker Cues.exe',
    f'Beatmaker-Cues-Plug-ins-{version}-Windows-x64.zip': f'Beatmaker-Cues-Plug-ins-{version}-Windows-x64/VST3/Beatmaker Cues.vst3/Contents/x86_64-win/Beatmaker Cues.vst3',
}
def digest(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()

for file in assets:
    if not file.is_file() or file.stat().st_size == 0:
        raise RuntimeError(f'Missing release asset: {file}')
    if file.suffix in {'.zip', '.ipa', '.apk'}:
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None:
                raise RuntimeError(f'Corrupt archive: {file}')
            for name in archive.namelist():
                path = PurePosixPath(name)
                if '..' in path.parts or path.is_absolute() or name.endswith(('.mobileprovision', '.jks', '.keystore', 'keystore.properties')):
                    raise RuntimeError(f'Private/nonportable file in public asset {file}: {name}')
            if file.name in native_expectations:
                data = archive.read(native_expectations[file.name])
                if file.name.endswith('Windows-x64.zip'):
                    offset = int.from_bytes(data[60:64], 'little')
                    if data[:2] != b'MZ' or data[offset:offset+4] != b'PE\0\0' or int.from_bytes(data[offset+4:offset+6], 'little') != 0x8664:
                        raise RuntimeError(f'Not a real Windows x64 native binary: {file}')
                elif data[:4] not in {b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'}:
                    raise RuntimeError(f'Not a universal Mac native binary: {file}')
            if '-Xcode-' in file.name:
                names = [name for name in archive.namelist() if name.count('/') == 1 and name.endswith('/SOURCE-INFO.json')]
                info = json.loads(archive.read(names[0])) if len(names) == 1 else {}
                if info.get('sourceCommit') != sha or info.get('workingTreeDirty') is not False:
                    raise RuntimeError(f'Xcode export has a different/dirty source baseline: {file}')
    if file.suffix == '.exe' and file.read_bytes()[:2] != b'MZ':
        raise RuntimeError(f'Not a real Windows installer: {file}')

# Cross-check the desktop build records against the exact installers being staged.
by_name = {file.name: file for file in assets}
for platform in ['macOS', 'Windows']:
    for name, value in builds[f'Main-Build-{platform}-{version}.json']['files'].items():
        if name not in by_name or digest(by_name[name]) != value['sha256']:
            raise RuntimeError(f'Desktop installer does not match its build record: {name}')

output.mkdir(parents=True, exist_ok=True)
expected = {file.name for file in assets + records} | {f'Release-Notes-{version}.md', f'Release-Build-{version}.json', f'SHA256SUMS-{version}.txt'}
unexpected = {file.name for file in output.iterdir()} - expected
if unexpected:
    raise RuntimeError(f'Unexpected files in public release staging: {unexpected}')
for file in assets + records:
    shutil.copy2(file, output / file.name)
shutil.copy2(root / 'docs' / f'release-{version}-notes.md', output / f'Release-Notes-{version}.md')
inventory = [{'name': file.name, 'bytes': file.stat().st_size, 'sha256': digest(file)} for file in sorted(output.iterdir()) if file.name not in {f'Release-Build-{version}.json', f'SHA256SUMS-{version}.txt'}]
manifest = {'version': version, 'sourceCommit': sha, 'workingTreeDirty': False,
            'scope': ['macOS', 'Windows', 'Android', 'iOS'],
            'nativeStandalone': ['macOS-universal', 'Windows-x64'],
            'fullDesktopStudio': ['macOS-arm64', 'macOS-x64', 'Windows-x64'],
            'iosSigning': 'unsigned', 'iosPhysicalScreenOffCheck': 'pending',
            'buildRecords': builds, 'files': inventory}
(output / f'Release-Build-{version}.json').write_text(json.dumps(manifest, indent=2) + '\n')
files = sorted(file for file in output.iterdir() if file.name != f'SHA256SUMS-{version}.txt')
(output / f'SHA256SUMS-{version}.txt').write_text(''.join(f'{digest(file)}  {file.name}\n' for file in files))
print(f'Verified {len(files)+1} public release assets from clean source {sha}: {output}')
