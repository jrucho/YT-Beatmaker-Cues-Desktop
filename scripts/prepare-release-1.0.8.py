"""Stage the native and version-aligned desktop releases from verified CI assets."""
import argparse
import json
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import subprocess
import tarfile
import zipfile

from hashlib import file_digest


def digest(file):
    with file.open('rb') as stream:
        return file_digest(stream, 'sha256').hexdigest()


def safe_entry(name):
    parts = PurePosixPath(name.replace('\\', '/')).parts
    return (name and not name.startswith(('/', '\\')) and ':' not in name and '..' not in parts
            and not name.lower().endswith(('.mobileprovision', '.provisionprofile', '.jks', '.keystore',
                                          '.p12', '.p8', 'keystore.properties'))
            and not any(part in {'Before', 'Readback', 'Relocated', 'xcuserdata'} for part in parts)
            and not any(part.startswith('Saved-data-before-update') for part in parts))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / 'package.json').read_text())['version']
    if version != '1.0.8' or args.output.exists():
        raise RuntimeError('Expected a fresh output directory for the 1.0.8 release')
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
        raise RuntimeError('Stage from the exact clean CI commit')

    files = {}
    builds = {}
    def build_identity(file):
        info = json.loads(file.read_text())
        if info.get('sourceCommit') != sha or info.get('version') != version or info.get('workingTreeDirty') is not False:
            raise RuntimeError(f'Wrong build provenance: {file.name}')
        builds[file.name] = info
        return info

    def take(artifact, record, checksum, expected):
        folder = args.artifacts / artifact
        checksums = {}
        for line in (folder / checksum).read_text().splitlines():
            hash_value, name = line.split('  ', maxsplit=1)
            if '/' in name or '\\' in name or name in checksums:
                raise RuntimeError(f'Invalid hash inventory in {checksum}')
            checksums[name] = hash_value
        if set(checksums) != set(expected) | {record}:
            raise RuntimeError(f'Unexpected asset inventory in {checksum}')
        for name, hash_value in checksums.items():
            file = folder / name
            if name in files or not file.is_file() or digest(file) != hash_value:
                raise RuntimeError(f'Missing, duplicated or mismatched asset: {name}')
            files[name] = file
        return build_identity(folder / record)

    for platform, arch in [('macOS', 'universal'), ('Windows', 'x64'), ('Linux', 'x64')]:
        suffix = f'{version}-{platform}-{arch}'
        names = [f'Beatmaker-Cues-Plug-ins-{suffix}.zip', f'Beatmaker-Cues-Plugin-Standalone-{suffix}.zip']
        if platform == 'Linux':
            names.append(f'Beatmaker-Cues-Plug-ins-{suffix}.deb')
        info = take(f'native-plugins-{platform}-{arch}-main', f'Plugin-Build-{suffix}.json',
                    f'SHA256SUMS-Plugins-{suffix}.txt', names)
        formats = {'VST3', 'Standalone', 'AU'} if platform == 'macOS' else {'VST3', 'Standalone'}
        if (info.get('edition') != 'main' or info.get('architecture') != arch or info.get('platform') != platform
                or set(info.get('formats', [])) != formats or not {'engine', 'persistence', 'vst3-host', 'webview-offline'} <= set(info.get('checks', []))):
            raise RuntimeError(f'Missing native checks or targets for {platform}')

    android = take('native-standalone-Android-arm64', f'Plugin-Build-{version}-Android-arm64.json',
                   f'SHA256SUMS-Plugins-{version}-Android-arm64.txt', [f'Beatmaker-Cues-{version}-Android-arm64.apk'])
    if (android.get('applicationId') != 'app.owaega.beatmakercuesstandalone'
            or android.get('architecture') != 'arm64-v8a' or android.get('formats') != ['Standalone']
            or not {'native-build', 'apk-signature'} <= set(android.get('checks', []))
            or android.get('developmentOnly') is not False or android.get('signing') != 'persistent-release-key'
            or android.get('certificateSha256') != (root / 'mobile/android/release-certificate.sha256').read_text().strip()):
        raise RuntimeError('Android release signing does not match the installed public app')

    ipa = f'Beatmaker-Cues-{version}-iOS-unsigned.ipa'
    xcode = f'Beatmaker-Cues-Plugin-Xcode-{version}.zip'
    ios = take('native-auv3-ios', f'AUv3-Build-{version}.json', f'SHA256SUMS-AUv3-{version}.txt', [ipa, xcode])
    if ios.get('signing') != 'unsigned' or ios.get('architecture') != 'arm64' or ios.get('extensionEmbedded') is not True:
        raise RuntimeError('iOS must be unsigned with its AUv3')

    take('native-verified-source', f'Source-Build-{version}.json', f'SHA256SUMS-Source-{version}.txt',
         [f'Beatmaker-Cues-Source-{version}.zip', f'Beatmaker-Cues-Source-{version}.tar.gz',
          f'Beatmaker-Cues-Plugin-Source-{version}.zip'])

    baseline = json.loads((root / 'desktop/release-baseline.json').read_text())
    studio_source = f'Beatmaker-Cues-Desktop-Source-{version}.zip'
    installers = {
        'macOS': [f'YT-Beatmaker-Cues-Desktop-{version}-macOS-{arch}.dmg' for arch in ['arm64', 'x64']],
        'Windows': [f'YT-Beatmaker-Cues-Desktop-{version}-Windows.exe'],
        'Linux': [f'YT-Beatmaker-Cues-Desktop-{version}-Linux-{arch}.{suffix}'
                  for arch in ['x64', 'arm64'] for suffix in ['AppImage', 'deb']],
    }
    desktop_digests = set()
    for platform, names in installers.items():
        folder = args.artifacts / f'desktop-maintenance-{platform}'
        record = f'Main-Build-{platform}-{version}.json'
        records = list(folder.rglob(record))
        if len(records) != 1:
            raise RuntimeError(f'Missing or ambiguous desktop build record: {record}')
        info = build_identity(records[0])
        if (info.get('platform') != platform or info.get('desktopBaselineCommit') != baseline['baselineCommit']
                or info.get('baselineVersion') != baseline['baselineVersion']
                or info.get('versionedFiles') != baseline['versionedFiles']
                or info.get('unchangedDesktopFunctionality') is not True
                or not {'desktop-regression', 'native-packaging'} <= set(info.get('checks', []))
                or set(info.get('files', {})) != {*names, studio_source}):
            raise RuntimeError(f'Unexpected desktop maintenance build: {platform}')
        for name, details in info['files'].items():
            matches = list(folder.rglob(name))
            if len(matches) != 1 or matches[0].stat().st_size != details['bytes'] or digest(matches[0]) != details['sha256']:
                raise RuntimeError(f'Desktop installer or source checksum mismatch: {name}')
            files[name] = matches[0]
            if name == studio_source:
                desktop_digests.add(details['sha256'])
        # Upload-artifact preserves a separate subdirectory for the studio outputs.
        files[record] = records[0]
    if len(desktop_digests) != 1:
        raise RuntimeError('Desktop builds did not use identical version-aligned source')

    for name, file in files.items():
        if file.suffix in {'.zip', '.ipa', '.apk'}:
            with zipfile.ZipFile(file) as archive:
                entries = archive.namelist()
                if len(entries) != len(set(entries)) or archive.testzip() or not all(map(safe_entry, entries)):
                    raise RuntimeError(f'Invalid or private archive: {name}')
                if '-Source-' in name or name == xcode:
                    records = [entry for entry in entries if entry.count('/') == 1 and entry.endswith('/SOURCE-INFO.json')]
                    info = json.loads(archive.read(records[0])) if len(records) == 1 else {}
                    if info.get('sourceCommit') != sha or info.get('version') != version:
                        raise RuntimeError(f'Source checkout mismatch: {name}')
                    if name == studio_source:
                        if (info.get('desktopBaselineCommit') != baseline['baselineCommit']
                                or info.get('unchangedDesktopFunctionality') is not True):
                            raise RuntimeError('Wrong full desktop source baseline')
                        prefix = records[0].rsplit('/', maxsplit=1)[0] + '/'
                        with_source = set(info['sourceFiles'])
                        if set(entries) != {records[0], *(prefix + path for path in with_source)}:
                            raise RuntimeError('Wrong full desktop source inventory')
                        for path, expected in info['sourceFiles'].items():
                            with archive.open(prefix + path) as stream:
                                if file_digest(stream, 'sha256').hexdigest() != expected:
                                    raise RuntimeError(f'Wrong full desktop source content: {path}')
                if name == ipa:
                    if any('_CodeSignature' in PurePosixPath(entry).parts for entry in entries):
                        raise RuntimeError('Personal or unexpected iOS signing')
                    prefix = 'Payload/Beatmaker Cues.app/'
                    app = plistlib.loads(archive.read(prefix + 'Info.plist'))
                    extensions = [entry for entry in entries if entry.startswith(prefix + 'PlugIns/') and entry.endswith('.appex/Info.plist')]
                    ext = plistlib.loads(archive.read(extensions[0])) if len(extensions) == 1 else {}
                    if (app.get('CFBundleIdentifier') != 'app.owaega.beatmakercuesprototype'
                            or ext.get('CFBundleIdentifier') != 'app.owaega.beatmakercuesprototype.beatmakercuesprototypeAUv3'
                            or ext.get('NSExtension', {}).get('NSExtensionPointIdentifier') != 'com.apple.AudioUnit-UI'
                            or not all(info.get('CFBundleShortVersionString') == version and info.get('CFBundleVersion') == version for info in [app, ext])):
                        raise RuntimeError('Wrong public iOS bundle or version')
        elif name.endswith('.tar.gz'):
            with tarfile.open(file) as archive:
                if not all(safe_entry(item.name) for item in archive.getmembers()):
                    raise RuntimeError(f'Invalid or private archive: {name}')
                with archive.extractfile(f'Beatmaker-Cues-Source-{version}/SOURCE-INFO.json') as stream:
                    info = json.load(stream)
                if info.get('sourceCommit') != sha or info.get('version') != version:
                    raise RuntimeError(f'Source checkout mismatch: {name}')
        elif file.suffix == '.exe':
            with file.open('rb') as stream:
                header = stream.read(64)
                stream.seek(int.from_bytes(header[60:64], 'little'))
                if header[:2] != b'MZ' or stream.read(4) != b'PE\0\0':
                    raise RuntimeError('The desktop Windows installer is not a PE executable')

    args.output.mkdir()
    for name, file in files.items():
        shutil.copy2(file, args.output / name)
    notes = root / f'docs/release-{version}-notes.md'
    shutil.copy2(notes, args.output / f'Release-Notes-{version}.md')
    record = dict(version=version, sourceCommit=sha, scope='native-and-desktop', workingTreeDirty=False,
                  runURL=builds[f'AUv3-Build-{version}.json'].get('runURL'), builds=builds,
                  nativeUIArchiveSha256=digest(root / 'plugin/Assets/mobile-ui.zip'),
                  assets={name: digest(file) for name, file in files.items()})
    (args.output / f'Release-Build-{version}.json').write_text(json.dumps(record, indent=2) + '\n')
    (args.output / f'SHA256SUMS-{version}.txt').write_text(''.join(
        f'{digest(path)}  {path.name}\n' for path in sorted(args.output.iterdir())))
    print(f'Verified {len(list(args.output.iterdir()))} release assets at {sha}')


if __name__ == '__main__':
    main()
