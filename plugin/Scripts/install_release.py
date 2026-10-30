"""Install the unpacked native plug-in bundles into this user's plug-in folder."""
from pathlib import Path
import platform
import shutil
import os
import plistlib
import datetime
import uuid

def bundle_id(bundle):
    try:
        with (bundle/'Contents/Info.plist').open('rb') as stream:return plistlib.load(stream).get('CFBundleIdentifier')
    except (OSError,plistlib.InvalidFileException):return None

def install_mac_bundle(bundle,destination):
    identity=bundle_id(bundle)
    if not identity:raise RuntimeError(f'Missing native bundle identity: {bundle}')
    target=destination/bundle.name
    if target.exists() and bundle_id(target)!=identity:
        raise RuntimeError(f'Different product already occupies {target}; it was not replaced')
    previous=[item for item in destination.glob('*'+bundle.suffix) if bundle_id(item)==identity]
    moved=[]
    backup=Path.home()/'Library/Application Support/Beatmaker Cues/PluginBackups'/(datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])/destination.name
    try:
        for item in previous:
            backup.mkdir(parents=True,exist_ok=True);saved=backup/item.name
            shutil.move(str(item),str(saved));moved.append((item,saved))
        shutil.copytree(bundle,target,symlinks=True)
    except Exception:
        if target.exists():shutil.rmtree(target)
        for original,saved in reversed(moved):shutil.move(str(saved),str(original))
        raise
    if moved:print('Previous matching bundles backed up outside the DAW scan folder:',backup)

def main():
    root=Path(__file__).resolve().parent
    system=platform.system()
    if system=='Darwin':targets={'AU':Path.home()/'Library/Audio/Plug-Ins/Components','VST3':Path.home()/'Library/Audio/Plug-Ins/VST3'}
    elif system=='Windows':targets={'VST3':Path(os.environ['LOCALAPPDATA'])/'Programs/Common/VST3'}
    elif system=='Linux':targets={'VST3':Path.home()/'.vst3'}
    else:raise RuntimeError('Unsupported platform')
    for kind,destination in targets.items():
        destination.mkdir(parents=True,exist_ok=True)
        for bundle in (root/kind).iterdir():
            if system=='Darwin':install_mac_bundle(bundle,destination)
            elif bundle.is_dir():shutil.copytree(bundle,destination/bundle.name,dirs_exist_ok=True)
            else:shutil.copy2(bundle,destination/bundle.name)
            print('Installed:',destination/bundle.name)
    print('Restart/rescan your DAW. Existing library and DAW-session data are not removed.')

if __name__=='__main__':main()
