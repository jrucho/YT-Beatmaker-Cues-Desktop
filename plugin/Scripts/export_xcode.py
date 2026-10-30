"""Export a real, pre-generated native Xcode project with portable source paths.

CMake code-generation inputs are copied into the export and CMake-only script
phases are removed. Xcode compiles the same native targets and embeds AUv3 using
its existing Copy Files phase; recipients do not need Node or CMake to run it.
"""
from pathlib import Path
import argparse,hashlib,json,os,plistlib,re,shutil,subprocess,tempfile,zipfile
from source_info import source_info
parser=argparse.ArgumentParser();parser.add_argument('--build-dir',required=True);parser.add_argument('--output');parser.add_argument('--platform',choices=['iOS','macOS'],default='iOS');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;build=Path(args.build_dir).resolve()
version=json.loads((root.parent/'package.json').read_text())['version']
release=Path(args.output).resolve() if args.output else root.parent/'release';release.mkdir(parents=True,exist_ok=True)
stage=tempfile.TemporaryDirectory(prefix='beatmaker-xcode-export-')
output=Path(stage.name)/(f'Beatmaker-Cues-Plugin-Xcode-{version}'+('-macOS' if args.platform=='macOS' else ''));output.mkdir()
ignore=shutil.ignore_patterns('xcuserdata','.DS_Store','__pycache__','.git','build','packages','*.keystore','*.jks','*.mobileprovision','keystore.properties')
for name in ['Source','Assets','Web','Scripts','Tests','README.md','CMakeLists.txt','AGPL-3.0.txt']:
    source=root/name
    if source.is_dir():shutil.copytree(source,output/name,dirs_exist_ok=True,ignore=ignore)
    else:shutil.copy2(source,output/name)
shutil.copy2(root.parent/'THIRD_PARTY_NOTICES.md',output/'THIRD_PARTY_NOTICES.md')
shutil.copy2(root.parent/'LICENSE',output/'APPLICATION-LICENSE.txt')
(output/'SOURCE-INFO.json').write_text(json.dumps({'version':version,'platform':args.platform,**source_info(root.parent)},indent=2)+'\n')
mappings=[]
for dep,name in [('juce','JUCE'),('signalsmithstretch','SignalsmithStretch'),('signalsmithlinear','SignalsmithLinear')]:
    cache=(build/'CMakeCache.txt').read_text()
    override=re.search(r'^FETCHCONTENT_SOURCE_DIR_'+dep.upper()+r':[^=]+=(.+)$',cache,re.MULTILINE)
    source=Path(override.group(1)) if override and override.group(1).strip() else build/'_deps'/f'{dep}-src'
    if not source.is_dir():raise RuntimeError(f'Export requires the fetched {dep} source under {build}/_deps (use a fresh CI configure).')
    destination=output/'Frameworks'/name
    shutil.copytree(source,destination,dirs_exist_ok=True,ignore=ignore)
    mappings.append((str(source),'$(PROJECT_DIR)/Frameworks/'+name))
generated=output/'GeneratedBuild';generated.mkdir(exist_ok=True)
for name in ['BeatmakerCues_artefacts/JuceLibraryCode','juce_binarydata_MobileWebAssets']:
    source=build/name
    if source.exists():shutil.copytree(source,generated/name,dirs_exist_ok=True,ignore=ignore)
for source in (build/'CMakeFiles').glob('*.dir/Info.plist'):
    destination=generated/source.relative_to(build);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,destination)
project=build/'BeatmakerCuesPrototype.xcodeproj'
shutil.copytree(project,output/project.name,dirs_exist_ok=True,ignore=ignore)
projectFile=output/project.name/'project.pbxproj'
data=json.loads(subprocess.check_output(['plutil','-convert','json','-o','-',str(projectFile)]))
objects=data['objects'];scripts={key for key,value in objects.items() if value.get('isa')=='PBXShellScriptBuildPhase'}
for key in scripts:del objects[key]
for item in objects.values():
    if 'buildPhases' in item:item['buildPhases']=[key for key in item['buildPhases'] if key not in scripts]
    if item.get('isa')=='XCBuildConfiguration':
        settings=item.setdefault('buildSettings',{});settings['CODE_SIGN_STYLE']='Automatic';settings['CODE_SIGNING_ALLOWED']='YES';settings['DEVELOPMENT_TEAM']=''
        settings['CODE_SIGN_IDENTITY']='Apple Development'
for source,destination in [(str(build),'$(PROJECT_DIR)/GeneratedBuild'),(str(root),'$(PROJECT_DIR)')]:mappings.append((source,destination))
aliases=[]
for source,destination in mappings:
    aliases.append((source,destination))
    if source.startswith('/private/var/'):aliases.append((source.removeprefix('/private'),destination))
def portable(value):
    if isinstance(value,str):
        for source,destination in aliases:value=value.replace(source,destination)
        return value
    if isinstance(value,list):return [portable(item) for item in value]
    if isinstance(value,dict):return {key:portable(item) for key,item in value.items()}
    return value
data=portable(data)
relativeMappings=sorted([(os.path.relpath(source,root),destination.removeprefix('$(PROJECT_DIR)/')) for source,destination in mappings],key=lambda pair:len(pair[0]),reverse=True)
for item in data['objects'].values():
    if item.get('isa')=='PBXProject':item['projectDirPath']='';item['projectRoot']=''
    if item.get('isa')=='PBXFileReference' and item.get('sourceTree')=='SOURCE_ROOT':
        value=item.get('path','')
        for source,destination in relativeMappings:
            if value==source or value.startswith(source+'/'):
                value=destination+value[len(source):];break
        item['path']=value.removeprefix('$(PROJECT_DIR)/')
projectFile.write_text(json.dumps(data))
subprocess.run(['plutil','-convert','xml1',str(projectFile)],check=True)
# Xcode reads XML property lists as native pbxproj files too.
notes=output/'OPEN-IN-XCODE.md'
notes.write_text(('Open BeatmakerCuesPrototype.xcodeproj. Select BeatmakerCues_Standalone, BeatmakerCues_AU or BeatmakerCues_VST3 for My Mac. Set your Mac signing settings, or CODE_SIGNING_ALLOWED=NO for a local unsigned build. ' if args.platform=='macOS' else 'Open BeatmakerCuesPrototype.xcodeproj. Select BeatmakerCues_Standalone and your connected iPhone/iPad. Choose your Apple development team for the standalone and AUv3 targets; if the bundle ID is unavailable, set a unique container ID and matching child extension ID. App Groups are opt-in: sharing requires the same configured group and entitled provisioning profiles for the main app, container and AUv3. Unconfigured builds retain private storage. ')+'The legacy internal project/bundle IDs are retained for saved-state/data compatibility. See README.md for architecture and verification limitations.\n')
archive=release/(output.name+'.zip')
subprocess.run(['ditto','-c','-k','--keepParent',str(output),str(archive)],check=True)
manifest=release/(f'SHA256SUMS-Xcode-macOS-{version}.txt' if args.platform=='macOS' else f'SHA256SUMS-AUv3-{version}.txt')
previous=manifest.read_text().splitlines() if manifest.exists() else []
previous=[line for line in previous if not line.endswith('  '+archive.name)]
manifest.write_text('\n'.join(previous+[hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name])+'\n')
stage.cleanup()
print(archive)
