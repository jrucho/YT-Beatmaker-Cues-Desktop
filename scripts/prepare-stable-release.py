"""Stage the current verified native release and unchanged Electron studio builds."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or name.endswith(('.mobileprovision', '.jks', '.keystore', '.p12', '.p8', 'keystore.properties')):
        raise RuntimeError(f'Private or nonportable archive entry: {name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip():
        raise RuntimeError('Stable staging requires clean committed source')
    run = json.loads(subprocess.check_output(['gh', 'run', 'view', args.run_id, '--repo', 'jrucho/YT-Beatmaker-Cues-Desktop', '--json', 'headSha,conclusion,url'], text=True))
    if run['headSha'] != commit or run['conclusion'] != 'success':
        raise RuntimeError('The complete stable build must pass for this exact release commit')
    folder, output = Path(args.artifacts).resolve(), Path(args.output).resolve()
    if output.exists():
        raise RuntimeError('Use a new empty output directory')
    inventory = [
        f'Beatmaker-Cues-{version}-Android-arm64.apk', f'Plugin-Build-{version}-Android-arm64.json',
        f'Beatmaker-Cues-{version}-iOS-unsigned.ipa', f'Beatmaker-Cues-Plugin-Xcode-{version}.zip', f'AUv3-Build-{version}.json',
        f'Beatmaker-Cues-Source-{version}.zip', f'Beatmaker-Cues-Source-{version}.tar.gz',
        f'Beatmaker-Cues-Plugin-Source-{version}.zip', f'Source-Build-{version}.json',
        f'Beatmaker-Cues-Desktop-Source-{version}.zip',
        f'YT-Beatmaker-Cues-Desktop-{version}-Windows.exe',
        f'YT-Beatmaker-Cues-Desktop-{version}-macOS-arm64.dmg', f'YT-Beatmaker-Cues-Desktop-{version}-macOS-x64.dmg',
        f'Main-Build-macOS-{version}.json', f'Main-Build-Windows-{version}.json',
    ]
    for platform, arch in [('macOS', 'universal'), ('Windows', 'x64'), ('Linux', 'x64')]:
        inventory += [f'Beatmaker-Cues-Plug-ins-{version}-{platform}-{arch}.zip',
                      f'Beatmaker-Cues-Plugin-Standalone-{version}-{platform}-{arch}.zip',
                      f'Plugin-Build-{version}-{platform}-{arch}.json']
    inventory += [f'Beatmaker-Cues-Plug-ins-{version}-Linux-x64.deb']
    inputs = {}
    for name in inventory:
        matches = [file for file in folder.rglob(name) if file.is_file() and file.name == name]
        if not matches or len({digest(file) for file in matches}) != 1:
            raise RuntimeError(f'Missing or conflicting build artifact: {name}')
        inputs[name] = matches[0]
    builds = {name: json.loads(file.read_text()) for name, file in inputs.items() if name.endswith('.json')}
    for name, info in builds.items():
        if info.get('sourceCommit') != commit or info.get('workingTreeDirty') is not False or info.get('version') != version:
            raise RuntimeError(f'Build identity mismatch: {name}')
        for filename, value in info.get('files', {}).items():
            if filename not in inputs or digest(inputs[filename]) != value['sha256']:
                raise RuntimeError(f'Build record checksum mismatch: {filename}')
    android = builds[f'Plugin-Build-{version}-Android-arm64.json']
    if (android.get('applicationId') != 'app.owaega.beatmakercuesstandalone'
            or android.get('developmentOnly') is not False or android.get('signing') != 'persistent-release-key'
            or android.get('certificateSha256') != (ROOT / 'mobile/android/release-certificate.sha256').read_text().strip()):
        raise RuntimeError('Android must use its original production identity and certificate')
    if builds[f'AUv3-Build-{version}.json'].get('signing') != 'unsigned':
        raise RuntimeError('Only the unsigned iOS build is public')
    baseline = json.loads((ROOT / 'desktop/release-baseline.json').read_text())
    for platform in ['macOS', 'Windows']:
        desktop = builds[f'Main-Build-{platform}-{version}.json']
        if (desktop.get('desktopBaselineCommit') != baseline['baselineCommit']
                or desktop.get('unchangedDesktopFunctionality') is not True
                or desktop.get('versionedFiles') != baseline['versionedFiles']
                or 'desktop-regression' not in desktop.get('checks', [])):
            raise RuntimeError(f'Desktop maintenance verification is missing: {platform}')
    for name, file in inputs.items():
        if file.suffix in ['.zip', '.ipa', '.apk']:
            with zipfile.ZipFile(file) as archive:
                if archive.testzip() is not None:
                    raise RuntimeError(f'Corrupt release archive: {name}')
                for entry in archive.namelist():
                    safe_name(entry)
                if '-Source-' in name:
                    identities = [entry for entry in archive.namelist() if entry.count('/') == 1 and entry.endswith('/SOURCE-INFO.json')]
                    info = json.loads(archive.read(identities[0])) if len(identities) == 1 else {}
                    if info.get('version') != version or info.get('sourceCommit') != commit:
                        raise RuntimeError(f'Corresponding source identity mismatch: {name}')
                    if '-Desktop-Source-' in name:
                        if info.get('desktopBaselineCommit') != baseline['baselineCommit'] or not info.get('unchangedDesktopFunctionality'):
                            raise RuntimeError('Desktop source does not identify the unchanged baseline')
                        prefix = identities[0].rsplit('/', 1)[0] + '/'
                        for source, expected in info['sourceFiles'].items():
                            if hashlib.sha256(archive.read(prefix + source)).hexdigest() != expected:
                                raise RuntimeError(f'Desktop source file checksum mismatch: {source}')
                if file.suffix == '.ipa' and any('_CodeSignature' in PurePosixPath(entry).parts for entry in archive.namelist()):
                    raise RuntimeError('The public IPA must not contain personal signatures')
        elif name.endswith('.tar.gz'):
            with tarfile.open(file) as archive:
                for member in archive.getmembers():
                    safe_name(member.name)
        elif file.suffix == '.exe':
            with file.open('rb') as stream:
                header = stream.read(64)
                if header[:2] != b'MZ':
                    raise RuntimeError('Windows installer is not a PE executable')
                stream.seek(int.from_bytes(header[60:64], 'little'))
                if stream.read(4) != b'PE\0\0':
                    raise RuntimeError('Windows installer has an invalid PE header')
    output.mkdir(parents=True)
    for name, file in inputs.items():
        shutil.copy2(file, output / name)
    shutil.copy2(ROOT / f'docs/release-{version}-notes.md', output / f'Release-Notes-{version}.md')
    shutil.copy2(ROOT / f'docs/manual-acceptance-{version}.json', output / f'Manual-Acceptance-{version}.json')
    manifest = dict(version=version, sourceCommit=commit, workingTreeDirty=False, status='stable',
                    runURL=run['url'], scope=['macOS', 'Windows', 'Linux-native', 'Android', 'iOS-unsigned'],
                    desktopBaseline=baseline, buildRecords=builds,
                    files=[dict(name=file.name, bytes=file.stat().st_size, sha256=digest(file)) for file in sorted(output.iterdir())])
    (output / f'Release-Build-{version}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    checksums = ''.join(f'{digest(file)}  {file.name}\n' for file in sorted(output.iterdir()))
    (output / f'SHA256SUMS-{version}.txt').write_text(checksums)
    print(f'Verified {len(list(output.iterdir()))} stable assets from {commit}: {output}')


if __name__ == '__main__':
    main()
