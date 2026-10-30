"""Assemble the requested local apps, plug-ins and portable projects; never publish."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import zipfile
from source_info import source_info

parser=argparse.ArgumentParser()
parser.add_argument('--directory',required=True)
parser.add_argument('--native-build',default='plugin/build-mac-permanent')
args=parser.parse_args()
root=Path(__file__).resolve().parents[2]
output=Path(args.directory).resolve()
native=Path(args.native_build).resolve()/'BeatmakerCues_artefacts/Release'
version=json.loads((root/'package.json').read_text())['version']
for kind,suffix in [('AU','.component'),('VST3','.vst3')]:
    source=native/kind/('Beatmaker Cues'+suffix)
    assert source.is_dir(),f'Missing native bundle: {source}'
    shutil.copytree(source,output/'macOS/Native-Plugins'/kind/source.name,dirs_exist_ok=True,symlinks=True)
shutil.copy2(root/'plugin/Scripts/install_release.py',output/'macOS/Native-Plugins/install.py')
for platform,name in [('iOS',f'Beatmaker-Cues-Plugin-Xcode-{version}'),('macOS',f'Beatmaker-Cues-Plugin-Xcode-{version}-macOS')]:
    folder=output/platform/'Xcode';archive=folder/(name+'.zip')
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None,f'Corrupt project archive: {archive}'
        package.extractall(folder)
    assert (folder/name/'BeatmakerCuesPrototype.xcodeproj/project.pbxproj').is_file()
required=[f'Android/Beatmaker-Cues-{version}-Android-arm64.apk',
          f'iOS/Unsigned/Beatmaker-Cues-{version}-iOS-unsigned.ipa',
          f'iOS/Development-Signed/Beatmaker-Cues-{version}-iOS-development-signed.ipa',
          f'macOS/Native-Plugins/Beatmaker-Cues-Plug-ins-{version}-macOS-universal.zip']
for name in required:assert (output/name).is_file(),f'Missing delivery: {name}'
for name in ['macOS/Native-Standalone/Beatmaker Cues.app',
             'macOS/Full-Desktop-Studio/mac-arm64/YT Beatmaker Cues Desktop.app',
             'macOS/Full-Desktop-Studio/mac/YT Beatmaker Cues Desktop.app']:
    assert (output/name).is_dir(),f'Missing real standalone app: {name}'
files=[]
for file in sorted(output.rglob('*')):
    if file.is_file() and file.suffix.lower() in {'.apk','.ipa','.zip','.dmg'}:
        if any(part.endswith('.app') for part in file.relative_to(output).parts):continue
        if 'Xcode' in file.relative_to(output).parts and file.parent.name!='Xcode':continue
        digest=hashlib.sha256(file.read_bytes()).hexdigest()
        files.append({'name':file.relative_to(output).as_posix(),'sha256':digest,'bytes':file.stat().st_size})
manifest={'version':version,**source_info(root),'status':'local development; publication/push hold',
          'iosPhysicalScreenOffCheck':'pending user confirmation','files':files}
(output/'Local-Delivery.json').write_text(json.dumps(manifest,indent=2)+'\n')
(output/'SHA256SUMS.txt').write_text(''.join(file['sha256']+'  '+file['name']+'\n' for file in files))
print(f'Assembled {len(files)} archives/installers plus real app/bundle/project folders in {output}')
