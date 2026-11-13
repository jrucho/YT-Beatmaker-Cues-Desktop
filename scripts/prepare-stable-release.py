"""Stage the current verified native release and unchanged Electron studio builds."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
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
    parser.add_argument('--sources', help='Clean corresponding-source export refreshed for publication metadata')
    parser.add_argument('--refresh-tag', help='Refresh this existing version, preserving its original tag and recording asset-source provenance')
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    original_tag_commit = None
    if args.refresh_tag:
        if args.refresh_tag != f'v{version}':
            raise RuntimeError('Only refresh the exact current product version')
        published = json.loads(subprocess.check_output(['gh', 'release', 'view', args.refresh_tag, '--repo', 'jrucho/YT-Beatmaker-Cues-Desktop', '--json', 'isDraft,isPrerelease,tagName'], text=True))
        if published['isDraft'] or published['isPrerelease'] or published['tagName'] != args.refresh_tag:
            raise RuntimeError('The existing release must be a published stable release')
        reference = json.loads(subprocess.check_output(['gh', 'api', f'repos/jrucho/YT-Beatmaker-Cues-Desktop/git/ref/tags/{args.refresh_tag}'], text=True))['object']
        while reference['type'] == 'tag':
            reference = json.loads(subprocess.check_output(['gh', 'api', f'repos/jrucho/YT-Beatmaker-Cues-Desktop/git/tags/{reference["sha"]}'], text=True))['object']
        if reference['type'] != 'commit':
            raise RuntimeError('The original release tag must resolve to a commit')
        original_tag_commit = reference['sha']
    release_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip():
        raise RuntimeError('Stable staging requires clean committed source')
    run = json.loads(subprocess.check_output(['gh', 'run', 'view', args.run_id, '--repo', 'jrucho/YT-Beatmaker-Cues-Desktop', '--json', 'headSha,status,conclusion,url,jobs'], text=True))
    commit = run['headSha']
    if run['status'] != 'completed':
        raise RuntimeError('The release build must be complete before staging')
    required_jobs = {'source', 'desktop (macos-15, macOS)', 'desktop (windows-latest, Windows)',
                     'native / android-standalone', 'native / ios-auv3',
                     'native / desktop-plugins (macos-15, main)', 'native / desktop-plugins (windows-latest, main)'}
    jobs = {job['name']: job for job in run['jobs']}
    if len(jobs) != len(run['jobs']) or set(jobs) - required_jobs - {'native / desktop-plugins (ubuntu-24.04, main)'}:
        raise RuntimeError('Unexpected or duplicate release jobs')
    if any(name not in jobs or jobs[name]['status'] != 'completed' or jobs[name]['conclusion'] != 'success' for name in required_jobs):
        raise RuntimeError('Every source, desktop, Android, iOS and published native-host job must pass')
    # Publication-only follow-ups must never silently change already-built code.
    # Binaries keep their actual clean build SHA; refreshed source/notes also name
    # the publication commit. No app, version, dependency or compiler change fits
    # this explicit metadata allowlist.
    metadata_changes = []
    if commit != release_commit:
        subprocess.run(['git', 'merge-base', '--is-ancestor', commit, release_commit], cwd=ROOT, check=True)
        changes = subprocess.check_output(['git', 'diff', '--name-only', '-z', commit, release_commit], cwd=ROOT).decode().split('\0')
        allowed = {'README.md', 'CHANGELOG.md', '.github/workflows/plugins.yml', '.github/workflows/stable.yml',
                   'scripts/prepare-stable-release.py', f'docs/downloads-{version}.md',
                   f'docs/release-{version}-notes.md', f'docs/native-feature-parity-{version}.md',
                   f'docs/manual-acceptance-{version}.json'}
        if set(filter(None, changes)) - allowed:
            raise RuntimeError('Application/build inputs changed after the verified build; rebuild before publication')
        metadata_changes = sorted(filter(None, changes))
        for workflow in ['.github/workflows/plugins.yml', '.github/workflows/stable.yml']:
            previous = subprocess.check_output(['git', 'show', f'{commit}:{workflow}'], cwd=ROOT, text=True)
            current = (ROOT / workflow).read_text()
            def build_commands(text):
                return [line.strip() for line in text.splitlines()
                        if re.search(r'cmake|xcodebuild|gradlew|build_mobile_ui|installer:|prepare-desktop-maintenance\.py|PLUGIN_PRODUCT:|PLUGIN_CODE:', line)]
            if build_commands(previous) != build_commands(current):
                raise RuntimeError('Product identity or build commands changed after the verified build: ' + workflow)
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
    for platform, arch in [('macOS', 'universal'), ('Windows', 'x64')]:
        inventory += [f'Beatmaker-Cues-Plug-ins-{version}-{platform}-{arch}.zip',
                      f'Beatmaker-Cues-Plugin-Standalone-{version}-{platform}-{arch}.zip',
                      f'Plugin-Build-{version}-{platform}-{arch}.json']
    source_names = {f'Beatmaker-Cues-Source-{version}.zip', f'Beatmaker-Cues-Source-{version}.tar.gz',
                    f'Beatmaker-Cues-Plugin-Source-{version}.zip', f'Source-Build-{version}.json'}
    inputs = {}
    for name in inventory:
        source_folder = Path(args.sources).resolve() if args.sources and name in source_names else folder
        matches = [file for file in source_folder.rglob(name) if file.is_file() and file.name == name]
        if not matches or len({digest(file) for file in matches}) != 1:
            raise RuntimeError(f'Missing or conflicting build artifact: {name}')
        inputs[name] = matches[0]
    builds = {name: json.loads(file.read_text()) for name, file in inputs.items() if name.endswith('.json')}
    for name, info in builds.items():
        expected_commit = release_commit if args.sources and name == f'Source-Build-{version}.json' else commit
        if info.get('sourceCommit') != expected_commit or info.get('workingTreeDirty') is not False or info.get('version') != version:
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
        if args.refresh_tag and 'keyboard-looper-release' not in builds[f'Plugin-Build-{version}-{platform}-{"universal" if platform == "macOS" else "x64"}.json'].get('checks', []):
            raise RuntimeError(f'Corrected native keyboard looper checks are missing: {platform}')
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
                    expected_commit = commit if '-Desktop-Source-' in name or not args.sources else release_commit
                    if info.get('version') != version or info.get('sourceCommit') != expected_commit:
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
    manifest = dict(version=version, sourceCommit=commit, releaseCommit=release_commit,
                    initialSourceCommit=original_tag_commit or release_commit,
                    releaseTag=args.refresh_tag or f'v{version}',
                    refresh='keyboard looper press/release correction; product version retained' if args.refresh_tag else None,
                    correspondingSourceCommit=release_commit if args.sources else commit,
                    workingTreeDirty=False, status='stable', requiredCIConclusion='success',
                    applicationBuildInputsUnchanged=True, publicationMetadataFiles=metadata_changes,
                    runURL=run['url'], scope=['macOS', 'Windows', 'Android', 'iOS-unsigned'],
                    ciJobs=[dict(name=name, conclusion=jobs[name]['conclusion']) for name in sorted(required_jobs)],
                    excludedPlatforms=[dict(platform='Linux-native', reason='User-approved deferral: native UI startup verification pending; no Linux binaries published',
                                            ciConclusion=jobs.get('native / desktop-plugins (ubuntu-24.04, main)', {}).get('conclusion', 'not requested'))],
                    desktopBaseline=baseline, buildRecords=builds,
                    files=[dict(name=file.name, bytes=file.stat().st_size, sha256=digest(file)) for file in sorted(output.iterdir())])
    (output / f'Release-Build-{version}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    checksums = ''.join(f'{digest(file)}  {file.name}\n' for file in sorted(output.iterdir()))
    (output / f'SHA256SUMS-{version}.txt').write_text(checksums)
    print(f'Verified {len(list(output.iterdir()))} stable assets from {commit}: {output}')


if __name__ == '__main__':
    main()
