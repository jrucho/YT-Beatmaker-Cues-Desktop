"""Retain the exact uncommitted development source, plan and candidate hashes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile
from source_info import source_info

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--candidate', action='append', default=[], help='Retained build/report directory or file to fingerprint')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False)
names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
sources = sorted({name for name in names if name and (root / name).is_file()})
for name in sources:
    file = Path(name)
    if file.suffix.lower() in {'.mobileprovision', '.jks', '.keystore', '.p12', '.p8'} or file.name.startswith('.env') or '..' in file.parts:
        raise RuntimeError('Private/nonportable source input: ' + name)
version = json.loads((root / 'package.json').read_text())['version']
archive = output / f'Source-{version}-development.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
    for name in sources:
        package.write(root / name, 'Beatmaker-Cues-Development/' + name)
with zipfile.ZipFile(archive) as package:
    if package.testzip() is not None:
        raise RuntimeError('Source archive integrity check failed')
(output / 'Working-tree.patch').write_bytes(subprocess.check_output(['git', 'diff', '--binary'], cwd=root))
for name in ['ios-feature-development.md', 'native-feature-parity-1.0.7.md']:
    shutil.copy2(root / 'docs' / name, output / name)
candidates = []
for name in args.candidate:
    source = Path(name).resolve()
    if not source.exists():
        raise RuntimeError('Candidate is missing: ' + str(source))
    files = sorted(file for file in source.rglob('*') if file.is_file()) if source.is_dir() else [source]
    candidates.append({'path': str(source.relative_to(root)), 'files': {str(file.relative_to(source) if source.is_dir() else file.name): hashlib.sha256(file.read_bytes()).hexdigest() for file in files}})
record = {'version': version, **source_info(root), 'sourceFiles': len(sources), 'scope': 'Local development candidates; no publication', 'candidates': candidates}
(output / 'Checkpoint.json').write_text(json.dumps(record, indent=2) + '\n')
(output / 'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name + '\n' for file in sorted(output.iterdir()) if file.is_file() and file.name != 'SHA256SUMS.txt'))
print(json.dumps({'result': 'PASS', 'output': str(output), 'version': version, 'sourceFiles': len(sources), 'candidates': len(candidates)}, indent=2))
