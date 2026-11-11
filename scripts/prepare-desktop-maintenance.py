"""Build the version-aligned Electron studio from its exact published baseline.

Prepare an isolated source tree and deterministic corresponding-source ZIP. Every
baseline source byte is retained except the explicit package version fields.
The record mode verifies that source again and hashes the resulting installers.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def baseline_files(config):
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', config['baselineCommit']))) as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts:
                raise RuntimeError(f'Invalid baseline path: {name}')
            if member.isfile():
                entries[str(name)] = (archive.extractfile(member).read(), member.mode, False)
            elif member.issym():
                if PurePosixPath(member.linkname).is_absolute() or '..' in PurePosixPath(member.linkname).parts:
                    raise RuntimeError(f'Nonportable baseline link: {name}')
                entries[str(name)] = (member.linkname.encode(), 0o777, True)
    return entries


def source_files(config):
    entries = baseline_files(config)
    for name in config['versionedFiles']:
        data, mode, link = entries[name]
        if link or json.loads(data)['version'] != config['baselineVersion']:
            raise RuntimeError(f'Unexpected baseline version: {name}')
        previous = f'"version": "{config["baselineVersion"]}"'.encode()
        updated = f'"version": "{config["version"]}"'.encode()
        if data.count(previous) != 1:
            raise RuntimeError(f'Expected exactly one product version in {name}')
        entries[name] = (data.replace(previous, updated, 1), mode, False)
    return entries


def add_zip(archive, name, data, mode, link=False):
    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.create_system = 3
    entry.external_attr = ((0o120000 if link else 0o100000) | mode) << 16
    entry.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(entry, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default='release/desktop-studio-source')
    parser.add_argument('--record', choices=['macOS', 'Windows'])
    parser.add_argument('--checks', default='')
    args = parser.parse_args()
    config = json.loads((ROOT / 'desktop/release-baseline.json').read_text())
    version = config['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or not re.fullmatch(r'[0-9a-f]{40}', config['baselineCommit']):
        raise RuntimeError('Use an exact version and pinned baseline commit')
    if json.loads((ROOT / 'package.json').read_text())['version'] != version:
        raise RuntimeError('Desktop maintenance manifest must match the current release')
    if config['versionedFiles'] != ['package.json', 'desktop/package.json', 'web/package.json']:
        raise RuntimeError('Only packaging and displayed app-version fields may change')
    directory = Path(args.directory).resolve()
    commit = git('rev-parse', 'HEAD').decode().strip()
    dirty = bool(git('status', '--porcelain').strip())
    entries = source_files(config)
    source_name = f'Beatmaker-Cues-Desktop-Source-{version}'
    archive_path = directory.parent / f'{source_name}.zip'
    identity = dict(version=version, sourceCommit=commit, workingTreeDirty=dirty,
                    desktopBaselineCommit=config['baselineCommit'], baselineVersion=config['baselineVersion'],
                    unchangedDesktopFunctionality=True, versionedFiles=config['versionedFiles'],
                    sourceFiles={name: digest(data) for name, (data, _, _) in entries.items()})
    if not args.record:
        if directory.exists() or archive_path.exists():
            raise RuntimeError('Use a new source directory and source archive; existing outputs are preserved')
        directory.mkdir(parents=True)
        for name, (data, mode, link) in entries.items():
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if link:
                target.symlink_to(data.decode())
            else:
                target.write_bytes(data)
                target.chmod(mode)
        source_record = json.dumps(identity, indent=2).encode() + b'\n'
        (directory / 'SOURCE-INFO.json').write_bytes(source_record)
        with zipfile.ZipFile(archive_path, 'w') as archive:
            for name, (data, mode, link) in sorted(entries.items()):
                add_zip(archive, f'{source_name}/{name}', data, mode, link)
            add_zip(archive, f'{source_name}/SOURCE-INFO.json', source_record, 0o644)
        print(f'Prepared {len(entries)} baseline files; only product-version fields changed: {directory}')
        print(archive_path)
        return

    if dirty:
        raise RuntimeError('Release build records require clean committed release source')
    if json.loads((directory / 'SOURCE-INFO.json').read_text()) != identity:
        raise RuntimeError('Prepared source identity no longer matches this release')
    for name, (data, _, link) in entries.items():
        actual = (directory / name).readlink().as_posix().encode() if link else (directory / name).read_bytes()
        if actual != data:
            raise RuntimeError(f'Desktop functionality source changed during packaging: {name}')
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Corrupt desktop source archive')
        for name, (data, _, _) in entries.items():
            if archive.read(f'{source_name}/{name}') != data:
                raise RuntimeError(f'Desktop source archive mismatch: {name}')
        if json.loads(archive.read(f'{source_name}/SOURCE-INFO.json')) != identity:
            raise RuntimeError('Desktop source archive identity mismatch')
    output = directory / 'release'
    expected = ([f'YT-Beatmaker-Cues-Desktop-{version}-macOS-{arch}.dmg' for arch in ['arm64', 'x64']]
                if args.record == 'macOS' else [f'YT-Beatmaker-Cues-Desktop-{version}-Windows.exe'])
    files = {name: dict(sha256=sha_file(output / name), bytes=(output / name).stat().st_size) for name in expected}
    files[archive_path.name] = dict(sha256=sha_file(archive_path), bytes=archive_path.stat().st_size)
    info = {key: value for key, value in identity.items() if key != 'sourceFiles'}
    info.update(platform=args.record, checks=args.checks.split(','), files=files,
                signing='ad-hoc; not notarized' if args.record == 'macOS' else 'unsigned')
    record = output / f'Main-Build-{args.record}-{version}.json'
    record.write_text(json.dumps(info, indent=2) + '\n')
    print(f'Verified unchanged desktop source and {len(expected)} installers: {record}')


if __name__ == '__main__':
    main()
