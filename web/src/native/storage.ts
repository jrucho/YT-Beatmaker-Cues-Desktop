import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { LibraryStorage } from "../../../server/src/library";
import {Capacitor,registerPlugin} from '@capacitor/core';

const SharedLibrary=registerPlugin<{info():Promise<{enabled:boolean}>;read(options?:{legacy?:string}):Promise<{json?:string;needsMigration?:boolean}>;commit(options:{base:string;edited:string}):Promise<{json:string}>}>('MusikeLibrary');
let sharedEnabled:Promise<boolean>|undefined;
const sharing=()=>sharedEnabled??=(Capacitor.getPlatform()==='ios'&&typeof(globalThis as any).__pluginInvoke!=='function'&&Capacitor.isPluginAvailable('MusikeLibrary')?SharedLibrary.info().then(result=>result.enabled):Promise.resolve(false));

const FILE = "library.json";
const TMP = "library.tmp.json";
const BACKUP = "library.backup.json";
const where = { directory: Directory.Data, encoding: Encoding.UTF8 } as const;

async function readText(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({ path, ...where });
    return typeof data === "string" ? data : await data.text();
  } catch {
    return null;
  }
}

/**
 * The library in the app's private storage. Each save goes to a temp file first and then replaces the real one,
 * so a crash mid-write can't leave a half-written library; if it happens between the two steps, the temp file
 * is the newest complete copy.
 */
export const nativeStorage: LibraryStorage = {
  reloadBeforeRead:Capacitor.getPlatform()==='ios'||typeof(globalThis as any).__pluginInvoke==='function',
  read: async () => {
    if(await sharing()){
      let result=await SharedLibrary.read();
      if(result.needsMigration){const legacy=await readPrivate();result=await SharedLibrary.read({legacy:legacy||JSON.stringify({favorites:[],playlists:[],history:[]})});}
      if(typeof result.json!=='string')throw new Error('Shared library returned no data');return result.json;
    }
    return readPrivate();
  },
  write: async (json,baseline) => {
    if(await sharing())return (await SharedLibrary.commit({base:baseline||JSON.stringify({favorites:[],playlists:[],history:[]}),edited:json})).json;
    const previous = await readText(FILE);
    if (previous != null) {
      try {
        const value = JSON.parse(previous);
        if (Array.isArray(value.favorites) && Array.isArray(value.playlists) && Array.isArray(value.history))
          await Filesystem.writeFile({ path: BACKUP, data: previous, ...where });
      } catch { /* preserve damaged primary until the new temporary file is ready */ }
    }
    await Filesystem.writeFile({ path: TMP, data: json, ...where });
    await Filesystem.deleteFile({ path: FILE, directory: Directory.Data }).catch(() => {});
    await Filesystem.rename({ from: TMP, to: FILE, directory: Directory.Data, toDirectory: Directory.Data });
  },
};
async function readPrivate():Promise<string|null>{
    let damaged = false;
    for (const name of [FILE, TMP, BACKUP]) {
      const text = await readText(name);
      if (text == null) continue;
      try { const value = JSON.parse(text); if (Array.isArray(value.favorites) && Array.isArray(value.playlists) && Array.isArray(value.history)) return text; } catch {}
      damaged = true;
    }
    if (damaged) throw new Error("Library data needs recovery; existing files have been retained");
    return null;
}
