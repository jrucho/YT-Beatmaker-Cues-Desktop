"""Collect local UI-preview artifacts and actual Mac apps without publishing."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from source_info import source_info

root=Path(__file__).resolve().parents[2]
version=json.loads((root/'package.json').read_text())['version']
parser=argparse.ArgumentParser()
parser.add_argument('--directory',default=f'release/Beatmaker-Cues-UI-Preview-{version}')
args=parser.parse_args()
output=Path(args.directory).resolve()
native=root/'plugin/build-mac-permanent/BeatmakerCues_artefacts/Release'
for kind,suffix in [('AU','.component'),('VST3','.vst3'),('Standalone','.app')]:
    source=native/kind/('Beatmaker Cues'+suffix)
    if not source.is_dir():raise RuntimeError(f'Missing native Mac build: {source}')
    destination=output/'macOS'/('Native-Standalone' if kind=='Standalone' else f'Native-Plugins/{kind}')/source.name
    shutil.copytree(source,destination,dirs_exist_ok=True,symlinks=True)
shutil.copy2(root/'plugin/Scripts/install_release.py',output/'macOS/Native-Plugins/install.py')
for arch in ['arm64','x64']:
    folder='mac-arm64' if arch=='arm64' else 'mac'
    app=root/'desktop/out'/folder/'YT Beatmaker Cues Desktop.app'
    current=(root/'web/dist/index.html').read_bytes()
    if (app/'Contents/Resources/web/index.html').read_bytes()!=current:raise RuntimeError(f'Desktop app does not contain the current UI: {app}')
    destination=output/'macOS/Full-Desktop-Studio'/folder/app.name
    shutil.copytree(app,destination,dirs_exist_ok=True,symlinks=True)
    installer=root/'release'/f'YT-Beatmaker-Cues-Desktop-{version}-macOS-{arch}.dmg'
    shutil.copy2(installer,output/'macOS/Full-Desktop-Studio'/installer.name)
files=[]
for file in sorted(output.rglob('*')):
    if not file.is_file() or file.suffix.lower() not in {'.apk','.ipa','.zip','.dmg'}:continue
    if any(part.endswith(('.app','.component','.vst3')) for part in file.relative_to(output).parts):continue
    files.append({'name':file.relative_to(output).as_posix(),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
manifest={'version':version,'status':'local UI preview',**source_info(root),'files':files,
          'changes':subprocess.check_output(['git','status','--short'],cwd=root,text=True).splitlines()}
(output/'Local-Preview.json').write_text(json.dumps(manifest,indent=2)+'\n')
(output/'SHA256SUMS.txt').write_text(''.join(f"{file['sha256']}  {file['name']}\n" for file in files))
print(f'Collected {len(files)} local packages and real Mac apps in {output}')
