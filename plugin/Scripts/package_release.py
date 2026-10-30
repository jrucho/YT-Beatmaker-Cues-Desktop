"""Package only native targets that exist; no simulated/cross-platform binaries."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import zipfile
from source_info import source_info

parser=argparse.ArgumentParser()
parser.add_argument('--build-dir',required=True)
parser.add_argument('--platform',choices=['macOS','Windows','Linux'],required=True)
parser.add_argument('--arch',required=True)
parser.add_argument('--checks',default='')
parser.add_argument('--output')
args=parser.parse_args()
root=Path(__file__).resolve().parent.parent
version=re.search(r'project\(BeatmakerCuesPrototype VERSION ([0-9.]+)',(root/'CMakeLists.txt').read_text()).group(1)
build=Path(args.build_dir).resolve()
artifacts=build/'BeatmakerCues_artefacts/Release'
output=Path(args.output).resolve() if args.output else root.parent/'release'
output.mkdir(parents=True,exist_ok=True)
cache=(build/'CMakeCache.txt').read_text()
desktop_beta=bool(re.search(r'^BEATMAKER_DESKTOP_BETA:BOOL=ON$',cache,re.MULTILINE))
product='Beatmaker Cues Desktop Beta' if desktop_beta else 'Beatmaker Cues'
package_prefix='Beatmaker-Cues-Desktop-Beta-Plug-ins' if desktop_beta else 'Beatmaker-Cues-Plug-ins'
standalone_prefix='Beatmaker-Cues-Desktop-Beta-Standalone' if desktop_beta else 'Beatmaker-Cues-Plugin-Standalone'
metadata_prefix='Desktop-Beta-Build' if desktop_beta else 'Plugin-Build'
formats=['VST3','Standalone']+(['AU'] if args.platform=='macOS' else [])
def native_target(kind):
    suffix='.component' if kind=='AU' else '.vst3' if kind=='VST3' else '.app' if args.platform=='macOS' else '.exe' if args.platform=='Windows' else ''
    return artifacts/kind/(product+suffix)
for kind in formats:
    folder=artifacts/kind
    if not folder.is_dir() or not any(folder.iterdir()):raise RuntimeError(f'Missing native target: {folder}')
    if not native_target(kind).exists():raise RuntimeError(f'Missing expected native product: {native_target(kind)}')
    if args.platform=='macOS':
        bundle=folder/(product+('.component' if kind=='AU' else '.vst3' if kind=='VST3' else '.app'))
        architectures=set(subprocess.check_output(['lipo','-archs',str(bundle/'Contents/MacOS'/product)],text=True).split())
        expected={'arm64','x86_64'} if args.arch=='universal' else {'x86_64' if args.arch=='x64' else args.arch}
        if architectures!=expected:raise RuntimeError(f'{bundle}: expected {expected}, found {architectures}')
        subprocess.run(['codesign','--force','--deep','--sign','-',str(bundle)],check=True)
        subprocess.run(['codesign','--verify','--deep','--strict',str(bundle)],check=True)
    elif args.platform=='Windows':
        binaries=list(folder.rglob('*.exe'))+list(folder.rglob('*.vst3'))
        assert any(file.is_file() and file.read_bytes()[:2]==b'MZ' for file in binaries),f'No PE binary in {folder}'
    else:
        assert any(file.is_file() and file.read_bytes()[:4]==b'\x7fELF' for file in folder.rglob('*')),f'No ELF binary in {folder}'

provenance=source_info(root.parent)
source=provenance['sourceCommit']
info={'version':version,'productName':product,'sourceCommit':source,'platform':args.platform,'architecture':args.arch,
      'edition':'desktop-beta' if desktop_beta else 'main',
      'formats':formats,'checks':args.checks.split(',') if args.checks else [],'signing':'ad-hoc' if args.platform=='macOS' else 'unsigned',
      'runURL':f"https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}" if os.environ.get('GITHUB_RUN_ID') else None}
info.update(provenance)

dependencies={}
for dependency in ['juce','signalsmithstretch','signalsmithlinear']:
    override=re.search(r'^FETCHCONTENT_SOURCE_DIR_'+dependency.upper()+r':[^=]+=(.+)$',cache,re.MULTILINE)
    sourceDirectory=Path(override.group(1)) if override else build/'_deps'/f'{dependency}-src'
    licenses=[file for file in sourceDirectory.glob('LICENSE*') if file.is_file()]
    if not licenses:raise RuntimeError(f'Missing {dependency} license: {sourceDirectory}')
    dependencies[dependency]=licenses

def add_tree(archive,folder,prefix):
    for file in folder.rglob('*'):
        if file.is_file():archive.write(file,str(Path(prefix)/file.relative_to(folder)))

def add_native(archive,kind,prefix):
    # Product renames may leave older outputs in a reused build directory.
    # Package exactly the selected native product, never all historical outputs.
    source=native_target(kind);destination=str(Path(prefix)/source.name)
    if source.is_dir():add_tree(archive,source,destination)
    else:archive.write(source,destination)

name=f'{package_prefix}-{version}-{args.platform}-{args.arch}'
target=output/(name+'.zip')
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
    for kind in formats:add_native(archive,kind,name+'/'+kind)
    archive.write(root/'README.md',name+'/README.md')
    archive.write(root/'AGPL-3.0.txt',name+'/Licenses/AGPL-3.0.txt')
    archive.write(root.parent/'LICENSE',name+'/Licenses/MIT-Application.txt')
    archive.write(root.parent/'THIRD_PARTY_NOTICES.md',name+'/Licenses/THIRD_PARTY_NOTICES.md')
    archive.write(root/'Source/dsp/WebKit-LICENSE.txt',name+'/Licenses/WebKit-LICENSE.txt')
    archive.write(root/'Scripts/install_release.py',name+'/install.py')
    archive.writestr(name+'/BuildInfo.json',json.dumps(info,indent=2)+'\n')
    for dependency,licenses in dependencies.items():
        for file in licenses:archive.write(file,name+'/Licenses/'+dependency+'-'+file.name)
standalone=output/f'{standalone_prefix}-{version}-{args.platform}-{args.arch}.zip'
with zipfile.ZipFile(standalone,'w',zipfile.ZIP_DEFLATED) as archive:
    add_native(archive,'Standalone','Beatmaker-Cues-Standalone')
    archive.write(root/'README.md','Beatmaker-Cues-Standalone/README.md')
    archive.write(root/'AGPL-3.0.txt','Beatmaker-Cues-Standalone/Licenses/AGPL-3.0.txt')
    archive.write(root.parent/'LICENSE','Beatmaker-Cues-Standalone/Licenses/MIT-Application.txt')
    archive.write(root.parent/'THIRD_PARTY_NOTICES.md','Beatmaker-Cues-Standalone/Licenses/THIRD_PARTY_NOTICES.md')
    archive.write(root/'Source/dsp/WebKit-LICENSE.txt','Beatmaker-Cues-Standalone/Licenses/WebKit-LICENSE.txt')
    archive.writestr('Beatmaker-Cues-Standalone/BuildInfo.json',json.dumps(info,indent=2)+'\n')
    for dependency,licenses in dependencies.items():
        for file in licenses:archive.write(file,'Beatmaker-Cues-Standalone/Licenses/'+dependency+'-'+file.name)
metadata=output/f'{metadata_prefix}-{version}-{args.platform}-{args.arch}.json'
metadata.write_text(json.dumps(info,indent=2)+'\n')
manifest=output/f'SHA256SUMS-{"Desktop-Beta" if desktop_beta else "Plugins"}-{version}-{args.platform}-{args.arch}.txt'
manifest.write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n' for file in [target,standalone,metadata]))
for file in [target,standalone,metadata,manifest]:print(file)

if args.platform=='Linux':
    with tempfile.TemporaryDirectory(prefix='beatmaker-plugin-deb-') as temp:
        stage=Path(temp)
        shutil.copytree(native_target('VST3'),stage/'usr/lib/vst3'/native_target('VST3').name,dirs_exist_ok=True)
        linux_name='beatmaker-cues-desktop-beta' if desktop_beta else 'beatmaker-cues-plugin'
        standalone=stage/'opt'/linux_name;standalone.mkdir(parents=True)
        shutil.copy2(native_target('Standalone'),standalone/native_target('Standalone').name)
        licenses=stage/'usr/share/doc'/linux_name;licenses.mkdir(parents=True)
        for notice,filename in [(root/'AGPL-3.0.txt','AGPL-3.0.txt'),(root.parent/'LICENSE','MIT-Application.txt'),(root.parent/'THIRD_PARTY_NOTICES.md','copyright'),(root/'Source/dsp/WebKit-LICENSE.txt','WebKit-LICENSE.txt')]:shutil.copy2(notice,licenses/filename)
        for dependency,files in dependencies.items():
            for source in files:shutil.copy2(source,licenses/(dependency+'-'+source.name))
        (stage/'DEBIAN').mkdir()
        (stage/'DEBIAN/control').write_text(f'Package: {linux_name}\nVersion: {version}\nArchitecture: amd64\nMaintainer: Beatmaker Cues <noreply@github.com>\nDepends: ffmpeg, libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libasound2t64 | libasound2, libcurl4t64 | libcurl4, libfreetype6\nDescription: Beatmaker Cues native standalone and VST3 instrument\n')
        desktop=stage/'usr/share/applications'/f'{linux_name}.desktop';desktop.parent.mkdir(parents=True)
        desktop.write_text(f'[Desktop Entry]\nType=Application\nName={product}\nExec="/opt/{linux_name}/{product}"\nTerminal=false\nCategories=AudioVideo;Audio;\n')
        deb=output/f'{package_prefix}-{version}-Linux-x64.deb'
        subprocess.run(['dpkg-deb','--build','--root-owner-group',str(stage),str(deb)],check=True)
        with manifest.open('a') as stream:stream.write(hashlib.sha256(deb.read_bytes()).hexdigest()+'  '+deb.name+'\n')
        print(deb)
