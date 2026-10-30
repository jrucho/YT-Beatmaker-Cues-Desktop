"""Verify a native plug-in refresh while preserving other published v1.0.4 bytes.

The tag remains the initial release; source and refreshed asset records explicitly
identify the newer commit. This only stages files and never publishes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
parser=argparse.ArgumentParser()
parser.add_argument('--previous',default=f'release/github-v{version}')
parser.add_argument('--delivery',default=f'release/Beatmaker-Cues-Local-Delivery-{version}')
parser.add_argument('--windows',required=True)
parser.add_argument('--sources',default=f'release/source-{version}')
parser.add_argument('--output',default=f'release/github-v{version}-keyboard')
args=parser.parse_args()
previous,delivery,windows,sources,output=[Path(value).resolve() for value in [args.previous,args.delivery,args.windows,args.sources,args.output]]
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
tag=subprocess.check_output(['git','rev-parse',f'v{version}^{{commit}}'],cwd=root,text=True).strip()
if subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip():raise RuntimeError('Commit/review the refresh source before staging')
if output==previous:raise RuntimeError('Preserve the initial release staging directory')
def digest(file):
    checksum=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):checksum.update(block)
    return checksum.hexdigest()

manifest=json.loads((previous/f'Release-Build-{version}.json').read_text())
for line in (previous/f'SHA256SUMS-{version}.txt').read_text().splitlines():
    expected,name=line.split('  ',1)
    if Path(name).name!=name or digest(previous/name)!=expected:raise RuntimeError(f'Initial release checksum mismatch: {name}')
if manifest['sourceCommit']!=tag:raise RuntimeError('Expected the original tagged release as the refresh baseline')
replacements=[delivery/'macOS/Native-Plugins'/f'{prefix}-{version}-macOS-universal.zip' for prefix in ['Beatmaker-Cues-Plug-ins','Beatmaker-Cues-Plugin-Standalone']]
replacements += [windows/f'{prefix}-{version}-Windows-x64.zip' for prefix in ['Beatmaker-Cues-Plug-ins','Beatmaker-Cues-Plugin-Standalone']]
replacements += [delivery/'macOS/Native-Plugins'/f'Plugin-Build-{version}-macOS-universal.json',windows/f'Plugin-Build-{version}-Windows-x64.json']
replacements += [sources/name for name in [f'Beatmaker-Cues-Source-{version}.zip',f'Beatmaker-Cues-Source-{version}.tar.gz',f'Beatmaker-Cues-Plugin-Source-{version}.zip',f'Source-Build-{version}.json']]
replacements += [delivery/'macOS/Xcode'/f'Beatmaker-Cues-Plugin-Xcode-{version}-macOS.zip']
for file in replacements:
    if not file.is_file():raise RuntimeError(f'Missing refreshed asset: {file}')
    if file.suffix=='.json':
        info=json.loads(file.read_text())
        if info['sourceCommit']!=sha or info.get('workingTreeDirty') is not False:raise RuntimeError(f'Refresh needs clean current-source metadata: {file}')
    if file.suffix=='.zip':
        with zipfile.ZipFile(file) as archive:
            if archive.testzip() is not None:raise RuntimeError(f'Corrupt refreshed ZIP: {file}')
            for name in archive.namelist():
                if name.startswith('/') or '..' in Path(name).parts or name.endswith(('.jks','.keystore','.mobileprovision','keystore.properties')):raise RuntimeError(f'Private/nonportable archive entry: {file}: {name}')
            infos=[name for name in archive.namelist() if name.endswith('/BuildInfo.json') or (name.count('/')==1 and name.endswith('/SOURCE-INFO.json'))]
            for name in infos:
                info=json.loads(archive.read(name))
                if info['sourceCommit']!=sha or (not info.get('sourceArchive') and info.get('workingTreeDirty') is not False):raise RuntimeError(f'Archive source identity mismatch: {file}')
            native=[name for name in archive.namelist() if name.endswith('Contents/x86_64-win/Beatmaker Cues.vst3') or name.endswith('/Beatmaker Cues.exe')]
            for name in native:
                data=archive.read(name);offset=int.from_bytes(data[60:64],'little')
                if data[:2]!=b'MZ' or data[offset:offset+4]!=b'PE\0\0' or int.from_bytes(data[offset+4:offset+6],'little')!=0x8664:raise RuntimeError(f'Not a Windows x64 binary: {file}')
output.mkdir(parents=True,exist_ok=True)
if any(output.iterdir()):raise RuntimeError('Use a new empty refresh output folder')
for file in previous.iterdir():
    if file.is_file():shutil.copy2(file,output/file.name)
for file in replacements:shutil.copy2(file,output/file.name)
shutil.copy2(root/'docs'/f'release-{version}-notes.md',output/f'Release-Notes-{version}.md')
updated={file.name for file in replacements}|{f'Release-Notes-{version}.md'}
for file in replacements:
    if file.name.startswith('Plugin-Build-') or file.name.startswith('Source-Build-'):manifest['buildRecords'][file.name]=json.loads(file.read_text())
manifest.update(sourceCommit=sha,initialSourceCommit=tag,workingTreeDirty=False,
                refresh='hosted number pads and Mac host keyboard routing',
                refreshedAssets=sorted(updated),retainedAssets=sorted(file.name for file in previous.iterdir() if file.is_file() and file.name not in updated|{f'Release-Build-{version}.json',f'SHA256SUMS-{version}.txt'}))
manifest['files']=[{'name':file.name,'bytes':file.stat().st_size,'sha256':digest(file)} for file in sorted(output.iterdir()) if file.name not in {f'Release-Build-{version}.json',f'SHA256SUMS-{version}.txt'}]
(output/f'Release-Build-{version}.json').write_text(json.dumps(manifest,indent=2)+'\n')
(output/f'SHA256SUMS-{version}.txt').write_text(''.join(f'{digest(file)}  {file.name}\n' for file in sorted(output.iterdir()) if file.name!=f'SHA256SUMS-{version}.txt'))
print(f'Verified {len(updated)} refreshed assets; retained other published bytes and original tag {tag}: {output}')
