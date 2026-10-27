import { pathToFileURL,fileURLToPath } from 'node:url';
import path from 'node:path';
import {readFileSync} from 'node:fs';
const root = process.env.BEATMAKER_APP_SOURCE;
const desktopBeta = process.env.BEATMAKER_DESKTOP_BETA === '1';
if (!root) throw new Error('BEATMAKER_APP_SOURCE must point to the app repository');
const original = (await import(pathToFileURL(path.join(root, 'web/vite.config.ts')).href)).default;
export default async (environment) => {
  const config = await original({ ...environment, mode: 'native' });
  config.root = path.join(root, 'web');
  config.base = './';
   config.define = { ...config.define, __APP_VERSION__: JSON.stringify((desktopBeta ? 'Desktop beta ' : 'Plug-in ')+JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version) };
  config.build = { ...config.build, outDir: process.env.BEATMAKER_PLUGIN_WEB_OUTPUT, emptyOutDir: true };
  config.plugins.push({
    name: 'beatmaker-plugin-adapter',
     enforce: 'pre',
     transformIndexHtml(html){return html.replace('<html ',`<html data-plugin-editor="${desktopBeta?'desktop':'vanilla'}" `);},
     transform(code, id) {
       if(desktopBeta && id.endsWith('/web/src/beatmaker/runtime.ts'))return readFileSync(new URL('./desktopRuntime.ts',import.meta.url),'utf8');
       if(desktopBeta && id.endsWith('/web/src/App.tsx'))return code
         .replace('useState(!!desktop || (!capabilities.retryOnError && new URLSearchParams(window.location.search).get("workspace") === "beatmaker"))','useState(true)')
         .replace('const [discover, setDiscover] = useState(true);','const [discover, setDiscover] = useState(false);')
         .replace('onStudio={capabilities.retryOnError ?', 'onStudio={false ?')
         .replace('onDiscover={() => setDiscover(true)}','onDiscover={() => setStudio(false)}');
       if(desktopBeta && id.endsWith('/web/src/beatmaker/Beatmaker.tsx'))return code
         .replace('<strong>BEATMAKER CUES</strong>','<strong>BEATMAKER CUES · DESKTOP BETA</strong>')
         .replace('if (window.musikeBeatmakerHost) window.musikeBeatmakerHost.midiOverwrite = midiOverwrite;', 'if (window.musikeBeatmakerHost) window.musikeBeatmakerHost.midiOverwrite = midiOverwrite; void (window as any).__pluginInvoke("midiOptions", {overwrite:midiOverwrite});')
         .replace('const timer = setInterval(() => {', 'const updateNativeDesktop = () => {')
         .replace('}, 150);', '}; window.addEventListener("plugin-desktop-state", updateNativeDesktop); updateNativeDesktop();')
         .replace('clearInterval(timer);', 'window.removeEventListener("plugin-desktop-state", updateNativeDesktop);')
         .replace('for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));', '(window as any).__pluginImportDesktopCues(Object.fromEntries(entries)); for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));')
         .replace('disabled={!track} aria-label="Toggle music video"', 'disabled title="Video is not host-routed in this beta" aria-label="Toggle music video"')
         .replace('<dt>Advanced</dt><dd>Original MIDI, stems, routing, loopers and effects controls</dd>', '<dt>Native controls</dt><dd>Host-routed cue, loop and speed controls. Browser stems/FX, sequencer, sidechain and VJ are not yet host-routed in this beta.</dd>')
         .replace('ADVANCED</button>','NATIVE CONTROLS</button>');
      if(id.endsWith('/web/src/player/player.ts'))return code.replaceAll('Math.max(-50','Math.max(-75');
       if(id.endsWith('/web/src/native/storage.ts'))return code.replace('const previous = await readText(FILE);','const previous: string | null = null; // Native store owns atomic backup and three-way merge.');
      if(id.endsWith('/web/src/views/Library.tsx'))return code.replace('<IconButton label={t.library.backup}',`<button type="button" className="rounded-full bg-surface-2 px-3 py-2 text-sm" onClick={async()=>{
        try{const track=await (window as any).__pluginInvoke('importAudio');if(track){await (window as any).__pluginStores.api.addFavorite(track);await useLibrary.getState().load();}}
        catch(error){(window as any).__pluginStores.ui.getState().toast((error as Error).message,'error');}
      }}>Import audio</button><IconButton label={t.library.backup}`);
      if (id.endsWith('/web/src/views/Search.tsx')) return code
        .replace('const timer = setTimeout(() => setQuery(text, playlistLink ? "playlist" : kind), 380);', 'const timer = setTimeout(() => {}, 0); // Plug-in searches only on explicit submit, keeping typing independent of networking.')
        .replace('if (!term || linkId) return setSuggestions([]);', 'if (!term || linkId || (window as any).__pluginReady) return setSuggestions([]);');
      if (id.endsWith('/web/src/lib/audio.ts')) return code.replace('?.musikeAudio;', '?.musikeAudio ?? (globalThis as any).__pluginAudioBridge;');
      if (id.endsWith('/web/src/native/ytplayer.ts')) return code.replace('?.musikeResolve;', '?.musikeResolve ?? (globalThis as any).__pluginResolveBridge;').replace('!!bridge && Capacitor.getPlatform() === "ios"', '!!bridge');
      if (id.endsWith('/web/src/native/streams.ts')) return code.replace('const ios = Capacitor.getPlatform() === "ios";', 'const ios = true;');
      if (id.endsWith('/web/src/native/midi.ts')) return code.replace('Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("MusikeMidi")', 'true');
      if (id.endsWith('/web/src/views/Cues.tsx')) return code.replace('min={-50}','min={-75}').replace('const [overwrite, setOverwrite] = useState(false);', `const [overwrite, setOverwrite] = useState(false);
        useEffect(() => { void (window as any).__pluginInvoke('midiOptions', { overwrite }); }, [overwrite]);`);
      if (!id.endsWith('/web/src/main.tsx')) return;
       return code + `\nimport ${JSON.stringify(fileURLToPath(new URL('./responsive.css',import.meta.url)).split(path.sep).join('/'))};
import {usePlayer as pluginPlayer} from './player/player';
import {useCueStore as pluginCues} from './mobile/cueStore';
import {api as pluginApi} from './lib/api';
import {useUi as pluginUi} from './stores/ui';
import {useLibrary as pluginLibrary} from './stores/library';
window.__pluginStores = {player:pluginPlayer,cues:pluginCues,api:pluginApi,ui:pluginUi,library:pluginLibrary};
pluginPlayer.subscribe(state => pluginCues.getState().setTrack(state.queue[state.index]?.id ?? null));
pluginCues.getState().setTrack(pluginPlayer.getState().queue[pluginPlayer.getState().index]?.id ?? null);
window.dispatchEvent(new Event('plugin-stores-ready'));
`;
    }
  });
  return config;
};
