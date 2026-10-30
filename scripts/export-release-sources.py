"""Export committed source and a plug-in corresponding-source/dependency bundle."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import urllib.request
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', default='release')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
version = json.loads((root / 'package.json').read_text())['version']
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
dirty = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=root, text=True).strip()
if dirty:
    raise RuntimeError('Release source exports require a clean committed checkout; commit/review the source first.')
tree = subprocess.check_output(['git', 'archive', '--format=tar', 'HEAD'], cwd=root)
members = tarfile.open(fileobj=io.BytesIO(tree))
names = {member.name for member in members.getmembers()}
source_record = json.dumps({'version': version, 'sourceCommit': sha, 'sourceArchive': True}, indent=2).encode() + b'\n'
required = {'package.json', 'pnpm-lock.yaml', 'plugin/CMakeLists.txt', 'plugin/Source/Processor.cpp', 'THIRD_PARTY_NOTICES.md', 'docs/build-from-source.md'}
if not required <= names:
    raise RuntimeError(f'Missing committed source inputs: {required - names}')
for name in names:
    parts = PurePosixPath(name).parts
    if any(part in {'node_modules', '.git', '.build-tools'} for part in parts) or name.endswith(('.jks', '.keystore', '.mobileprovision', 'keystore.properties')):
        raise RuntimeError(f'Private/generated file in source tree: {name}')

def add(archive, name, data, executable=False, symlink=False):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = ((0o120777 if symlink else 0o100755 if executable else 0o100644) << 16)
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, data)

def source_zip(destination, prefix):
    with zipfile.ZipFile(destination, 'w') as archive:
        add(archive, prefix + '/SOURCE-INFO.json', source_record)
        for member in members.getmembers():
            if member.isfile():
                add(archive, prefix + '/' + member.name, members.extractfile(member).read(), bool(member.mode & 0o111))
            elif member.issym():
                add(archive, prefix + '/' + member.name, member.linkname.encode(), symlink=True)

name = f'Beatmaker-Cues-Source-{version}'
source_zip(output / (name + '.zip'), name)
prefixed = subprocess.check_output(['git', 'archive', '--format=tar', f'--prefix={name}/', 'HEAD'], cwd=root)
combined = io.BytesIO()
with tarfile.open(fileobj=io.BytesIO(prefixed)) as original, tarfile.open(fileobj=combined, mode='w') as result:
    for member in original.getmembers():
        result.addfile(member, original.extractfile(member) if member.isfile() else None)
    record = tarfile.TarInfo(name + '/SOURCE-INFO.json');record.size=len(source_record);record.mode=0o644;record.mtime=0
    result.addfile(record,io.BytesIO(source_record))
(output / (name + '.tar.gz')).write_bytes(gzip.compress(combined.getvalue(), mtime=0))
plugin_name = f'Beatmaker-Cues-Plugin-Source-{version}'
plugin_archive = output / (plugin_name + '.zip')
source_zip(plugin_archive, plugin_name)
pins = []
cmake = (root / 'plugin/CMakeLists.txt').read_text()
for repository, directory in [('juce-framework/JUCE', 'JUCE'), ('Signalsmith-Audio/signalsmith-stretch', 'SignalsmithStretch'), ('Signalsmith-Audio/linear', 'SignalsmithLinear')]:
    match = re.search(r'https://github.com/' + re.escape(repository) + r'/archive/([0-9a-f]{40})\.tar\.gz', cmake)
    if not match:
        raise RuntimeError(f'Missing pinned source: {repository}')
    commit = match.group(1)
    url = f'https://codeload.github.com/{repository}/tar.gz/{commit}'
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = response.read()
    pins.append({'repository': repository, 'commit': commit, 'downloadSha256': hashlib.sha256(payload).hexdigest()})
    omitted = []
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as dependency, zipfile.ZipFile(plugin_archive, 'a') as archive:
        for member in dependency.getmembers():
            relative = PurePosixPath(member.name).parts[1:]
            if not relative or '..' in relative:
                continue
            # Upstream JUCE ships demo Android signing assets. They are unrelated
            # to these native targets and are not part of the public app export.
            if member.name.endswith(('.jks', '.keystore', '.mobileprovision', 'keystore.properties')):
                omitted.append('/'.join(relative))
                continue
            destination = plugin_name + '/Frameworks/' + directory + '/' + '/'.join(relative)
            if member.isfile():
                add(archive, destination, dependency.extractfile(member).read(), bool(member.mode & 0o111))
            elif member.issym():
                add(archive, destination, member.linkname.encode(), symlink=True)
    if omitted:
        pins[-1]['omittedExampleSigningAssets'] = omitted
metadata = output / f'Source-Build-{version}.json'
metadata.write_text(json.dumps({'version': version, 'sourceCommit': sha, 'workingTreeDirty': False, 'dependencies': pins}, indent=2) + '\n')
files = [output / (name + '.zip'), output / (name + '.tar.gz'), plugin_archive, metadata]
(output / f'SHA256SUMS-Source-{version}.txt').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name + '\n' for file in files))
for file in files:
    print(file)
