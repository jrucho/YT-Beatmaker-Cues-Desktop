"""Install the unpacked native plug-in bundles into this user's plug-in folder."""
from pathlib import Path
import platform
import shutil
import os

root=Path(__file__).resolve().parent
system=platform.system()
if system=='Darwin':targets={'AU':Path.home()/'Library/Audio/Plug-Ins/Components','VST3':Path.home()/'Library/Audio/Plug-Ins/VST3'}
elif system=='Windows':targets={'VST3':Path(os.environ['LOCALAPPDATA'])/'Programs/Common/VST3'}
elif system=='Linux':targets={'VST3':Path.home()/'.vst3'}
else:raise RuntimeError('Unsupported platform')
for kind,destination in targets.items():
    destination.mkdir(parents=True,exist_ok=True)
    for bundle in (root/kind).iterdir():
        if bundle.is_dir():shutil.copytree(bundle,destination/bundle.name,dirs_exist_ok=True)
        else:shutil.copy2(bundle,destination/bundle.name)
        print('Installed:',destination/bundle.name)
print('Restart/rescan your DAW. Existing library and DAW-session data are not removed.')
