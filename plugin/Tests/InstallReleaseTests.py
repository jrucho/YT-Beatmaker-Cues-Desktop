"""Exercise product-rename updates entirely inside a temporary user directory."""
from pathlib import Path
import plistlib
import runpy
import tempfile
from unittest.mock import patch

install=runpy.run_path(str(Path(__file__).resolve().parents[1]/'Scripts/install_release.py'))['install_mac_bundle']

def bundle(path,identity,marker):
    (path/'Contents').mkdir(parents=True)
    (path/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identity}))
    (path/'Contents'/marker).write_text(marker)
    return path

with tempfile.TemporaryDirectory(prefix='beatmaker-install-') as temporary:
    home=Path(temporary)
    with patch.object(Path,'home',return_value=home):
        source=bundle(home/'package/Beatmaker Cues.component','app.owaega.beatmakercuesprototype','new-icon')
        destination=home/'Library/Audio/Plug-Ins/Components';destination.mkdir(parents=True)
        previous=bundle(destination/'Beatmaker Cues Plug-in.component','app.owaega.beatmakercuesprototype','old-icon')
        unrelated=bundle(destination/'Unrelated.component','other.vendor.instrument','keep')
        install(source,destination)
        assert not previous.exists() and (destination/source.name/'Contents/new-icon').is_file()
        assert len(list((home/'Library/Application Support/Beatmaker Cues/PluginBackups').rglob('old-icon')))==1
        assert (unrelated/'Contents/keep').is_file()
        install(source,destination)
        assert (destination/source.name/'Contents/new-icon').is_file()
        with patch('shutil.copytree',side_effect=OSError('simulated copy failure')):
            try:install(source,destination)
            except OSError:pass
            else:raise AssertionError('Copy failure was not reported')
        assert (destination/source.name/'Contents/new-icon').is_file(),'Failed updates must restore the existing bundle'
        collision=bundle(home/'other/Beatmaker Cues.component','other.vendor.instrument','different')
        try:install(collision,destination)
        except RuntimeError:pass
        else:raise AssertionError('Unrelated same-name bundle was overwritten')
        assert (destination/source.name/'Contents/new-icon').is_file()
print('PASS: renamed bundle backup, repeat updates, rollback and unrelated-product preservation')
