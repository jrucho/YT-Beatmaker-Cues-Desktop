"""Create a private source/app/data checkpoint of an uncommitted iOS build."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--app', required=True)
parser.add_argument('--installation', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
app = Path(args.app).resolve()
installation = Path(args.installation).resolve()
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False)
metadata = plistlib.loads((app / 'Info.plist').read_bytes())
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
sources = sorted({name for name in files if name and (root / name).is_file()})
for name in sources:
    if name.endswith(('.mobileprovision', '.jks', '.keystore', '.p12', '.p8')) or '..' in Path(name).parts:
        raise RuntimeError('Private/nonportable source input: ' + name)
source = output / 'Source-1.0.7.zip'
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sources:
        archive.write(root / name, 'Beatmaker-Cues-Development/' + name)
diff = subprocess.check_output(['git', 'diff', '--binary'], cwd=root)
(output / 'Working-tree.patch').write_bytes(diff)
subprocess.run(['ditto', '-c', '-k', '--keepParent', str(app), str(output / 'Beatmaker-Cues-iPhone.app.zip')], check=True)
shutil.copy2(root / 'docs/ios-feature-development.md', output / 'PLAN-AND-RESUME.md')
shutil.copy2(installation / 'Installation.json', output / 'Installation.json')
if (root / 'release/OpenCode-storage-review.md').is_file():
    shutil.copy2(root / 'release/OpenCode-storage-review.md', output / 'OpenCode-storage-review.md')
with zipfile.ZipFile(output / 'Saved-data-before-update.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((installation / 'Before').rglob('*')):
        if file.is_file():
            archive.write(file, str(file.relative_to(installation / 'Before')))
    archive.write(installation / 'Before.json', 'Container-Info.json')
record = {'version': metadata['CFBundleShortVersionString'], 'build': metadata['CFBundleVersion'],
          'bundleId': metadata['CFBundleIdentifier'], 'sourceFiles': len(sources),
          'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
          'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip(),
          'workingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()),
          'scope': 'Private iPhone development checkpoint; includes development provisioning in the app archive',
          'files': {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in output.iterdir() if file.is_file()}}
(output / 'Checkpoint.json').write_text(json.dumps(record, indent=2) + '\n')
for file in output.glob('*.zip'):
    with zipfile.ZipFile(file) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('Corrupt checkpoint archive: ' + file.name)
(output / 'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name + '\n'
    for file in sorted(output.iterdir()) if file.is_file() and file.name != 'SHA256SUMS.txt'))
print(json.dumps({'result': 'PASS', 'output': str(output), **record}, indent=2))
