from pathlib import Path
import argparse,hashlib,json,os,plistlib,subprocess,zipfile
from source_info import source_info
parser=argparse.ArgumentParser();parser.add_argument('--build-dir',required=True);parser.add_argument('--output');parser.add_argument('--development-signed',action='store_true',help='Local registered-device testing only; includes development provisioning');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;build=Path(args.build_dir).resolve();output=Path(args.output).resolve() if args.output else root.parent/'release';output.mkdir(parents=True,exist_ok=True)
app=build/'BeatmakerCuesPlugin.xcarchive/Products/Applications/Beatmaker Cues.app'
if not app.is_dir():app=build/'BeatmakerCues_artefacts/Release/Standalone/Beatmaker Cues.app'
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
ipa=output/f'Beatmaker-Cues-{version}-iOS-{ "development-signed" if args.development_signed else "unsigned"}.ipa'
if args.development_signed:
    subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
    assert (app/'embedded.mobileprovision').is_file(),'Development IPA requires its device provisioning profile'
    profile=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(app/'embedded.mobileprovision')]))
    assert profile.get('Entitlements',{}).get('get-task-allow') and profile.get('ProvisionedDevices'),'Only registered-device development profiles are accepted for this local export'
else:assert not list(app.rglob('embedded.mobileprovision')),'Package the unsigned CI build, not a personal provisioning profile'
with zipfile.ZipFile(ipa,'w',zipfile.ZIP_DEFLATED) as archive:
    for file in app.rglob('*'):
        if file.is_file():archive.write(file,str(Path('Payload/Beatmaker Cues.app')/file.relative_to(app)))
metadata=output/f'AUv3-Build-{version}.json'
metadata.write_text(json.dumps({'version':version,**source_info(root.parent),
    'signing':'development-device' if args.development_signed else 'unsigned','architecture':'arm64','extensionEmbedded':True,
    'runURL':f"https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}" if os.environ.get('GITHUB_RUN_ID') else None},indent=2)+'\n')
manifest=output/f'SHA256SUMS-AUv3-{version}.txt';manifest.write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n' for file in [ipa,metadata]))
print(ipa)
