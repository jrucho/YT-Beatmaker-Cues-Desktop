from pathlib import Path
import argparse,hashlib,json,os,plistlib,subprocess,zipfile
from source_info import source_info
parser=argparse.ArgumentParser();parser.add_argument('--build-dir',required=True);parser.add_argument('--output');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;build=Path(args.build_dir).resolve();output=Path(args.output).resolve() if args.output else root.parent/'release';output.mkdir(parents=True,exist_ok=True)
app=build/'BeatmakerCuesPlugin.xcarchive/Products/Applications/Beatmaker Cues Plug-in.app'
if not app.is_dir():app=build/'BeatmakerCues_artefacts/Release/Standalone/Beatmaker Cues Plug-in.app'
assert app.is_dir(),'The real iOS container must be built before packaging'
info=plistlib.loads((app/'Info.plist').read_bytes());version=info['CFBundleShortVersionString']
extensions=list((app/'PlugIns').glob('*.appex'));assert len(extensions)==1,'AUv3 extension not embedded'
extension=plistlib.loads((extensions[0]/'Info.plist').read_bytes())
assert extension['CFBundleShortVersionString']==version
assert extension['NSExtension']['NSExtensionPointIdentifier']=='com.apple.AudioUnit-UI'
assert extension['CFBundleIdentifier'].startswith(info['CFBundleIdentifier']+'.')
for bundle,metadata in [(app,info),(extensions[0],extension)]:
    architecture=subprocess.check_output(['lipo','-archs',str(bundle/metadata['CFBundleExecutable'])],text=True)
    assert 'arm64' in architecture
ipa=output/f'Beatmaker-Cues-AUv3-{version}-iOS-unsigned.ipa'
assert not list(app.rglob('embedded.mobileprovision')),'Package the unsigned CI build, not a personal provisioning profile'
with zipfile.ZipFile(ipa,'w',zipfile.ZIP_DEFLATED) as archive:
    for file in app.rglob('*'):
        if file.is_file():archive.write(file,str(Path('Payload/BeatmakerCuesPlugin.app')/file.relative_to(app)))
metadata=output/f'AUv3-Build-{version}.json'
metadata.write_text(json.dumps({'version':version,**source_info(root.parent),
    'signing':'unsigned','architecture':'arm64','extensionEmbedded':True,
    'runURL':f"https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}" if os.environ.get('GITHUB_RUN_ID') else None},indent=2)+'\n')
manifest=output/f'SHA256SUMS-AUv3-{version}.txt';manifest.write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n' for file in [ipa,metadata]))
print(ipa)
