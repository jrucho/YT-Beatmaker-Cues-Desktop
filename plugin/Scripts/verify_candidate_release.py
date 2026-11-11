"""Read-only verification of GitHub asset names, sizes and SHA-256 digests."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--directory', required=True)
parser.add_argument('--repo', required=True)
parser.add_argument('--tag', required=True)
parser.add_argument('--state', choices=['draft', 'published'], required=True)
parser.add_argument('--report')
parser.add_argument('--stable', action='store_true', help='Verify a normal stable release instead of a prerelease')
args = parser.parse_args()
folder = Path(args.directory).resolve()
manifests = list(folder.glob('SHA256SUMS-[0-9]*.txt' if args.stable else 'SHA256SUMS-Candidate-*.txt'))
if len(manifests) != 1:
    raise RuntimeError('Expected one candidate checksum manifest')
expected = {}
for line in manifests[0].read_text().splitlines():
    digest, name = line.split('  ', 1)
    if Path(name).name != name or name in expected:
        raise RuntimeError('Invalid or duplicate candidate filename')
    file = folder / name
    if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Local checksum mismatch: ' + name)
    expected[name] = digest
expected[manifests[0].name] = hashlib.sha256(manifests[0].read_bytes()).hexdigest()
if {file.name for file in folder.iterdir()} != set(expected):
    raise RuntimeError('Unexpected file in the candidate upload directory')
release = json.loads(subprocess.check_output([
    'gh', 'release', 'view', args.tag, '--repo', args.repo,
    '--json', 'url,tagName,isDraft,isPrerelease,assets,targetCommitish',
], text=True))
if release['isDraft'] != (args.state == 'draft') or release['isPrerelease'] != (not args.stable) or release['tagName'] != args.tag:
    raise RuntimeError('Unexpected GitHub candidate release state')
assets = {asset['name']: asset for asset in release['assets']}
if set(assets) != set(expected):
    raise RuntimeError('GitHub asset list differs from the verified upload list')
for name, digest in expected.items():
    asset = assets[name]
    if asset['state'] != 'uploaded' or asset['size'] != (folder / name).stat().st_size or asset.get('digest') != 'sha256:' + digest:
        raise RuntimeError('GitHub asset size/state/digest mismatch: ' + name)
report = {'result': 'PASS', 'url': release['url'], 'tag': args.tag,
          'isDraft': release['isDraft'], 'isPrerelease': release['isPrerelease'],
          'targetCommitish': release['targetCommitish'], 'verifiedAssets': len(expected), 'digests': expected}
if args.report:
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
