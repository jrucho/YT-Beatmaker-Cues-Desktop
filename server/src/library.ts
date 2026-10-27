import { msg } from "./i18n.js";
import { HttpError, VIDEO_ID, type Library, type Playlist, type Track } from "./types.js";

// No Node-only imports here: the Android app runs this same module, with its own storage.

const HISTORY_LIMIT = 60;

/** Where the library is kept: a file on the server and the desktop app, app storage on Android. */
export interface LibraryStorage {
  read(): Promise<string | null>;
  write(json: string,baseline?:string): Promise<void|string>;
  reloadBeforeRead?: boolean;
}

let storage: LibraryStorage | null = null;
let state: Library | null = null;
let writeChain: Promise<void> = Promise.resolve();
let loading: Promise<Library> | null = null;
let lastLoadedJson:string|null|undefined;
let persistedBaseline='';
let mutations:Promise<unknown>=Promise.resolve();
function mutate<T>(action:(library:Library)=>Promise<T>):Promise<T>{
  const work=mutations.catch(()=>{}).then(async()=>action(await load()));mutations=work;return work;
}

/** Set once at startup, before any request. */
export function useLibraryStorage(s: LibraryStorage) {
  storage = s;
  state = null;
  loading = null;
  lastLoadedJson=undefined;
  persistedBaseline='';
}

const randomUUID = () => globalThis.crypto.randomUUID();

async function load(): Promise<Library> {
  if (state && !storage?.reloadBeforeRead) return state;
  if (loading) return loading;
  if (!storage) throw new Error("Library storage not configured");
  loading = (async () => {
    await writeChain.catch(()=>{});
    const json = await storage!.read();
    if(state&&lastLoadedJson===json)return state;
    state = json ? cleanLibrary(JSON.parse(json)) : { favorites: [], playlists: [], history: [] };
    lastLoadedJson=json;
    persistedBaseline=JSON.stringify(state);
    return state;
  })().finally(() => { loading = null; });
  return loading;
}

/** Serialized writes so concurrent requests never interleave. */
function persist(): Promise<void> {
  lastLoadedJson=undefined;
  const snapshot = JSON.stringify(state, null, 2);
  const baseline=persistedBaseline;
  writeChain = writeChain.catch(() => {}).then(async() => {
    const committed=await storage!.write(snapshot,baseline);
    if(typeof committed==='string'&&state)Object.assign(state,cleanLibrary(JSON.parse(committed)));
    persistedBaseline=typeof committed==='string'?committed:snapshot;
  });
  return writeChain;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export function sanitizeTrack(input: unknown): Track {
  const t = (input ?? {}) as Record<string, unknown>;
  const id = str(t.id, 11);
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidTrack"));
  const url = (v: unknown) => {
    const s = str(v, 500);
    return /^https:\/\//.test(s) ? s : "";
  };
  return {
    id,
    title: str(t.title, 300) || "Untitled",
    artist: str(t.artist, 300),
    album: str(t.album, 300) || undefined,
    duration: typeof t.duration === "number" && Number.isFinite(t.duration) ? Math.max(0, Math.round(t.duration)) : 0,
    thumb: url(t.thumb),
    art: url(t.art),
    kind: t.kind === "video" ? "video" : "song",
  };
}

function findPlaylist(lib: Library, pid: string): Playlist {
  const p = lib.playlists.find((x) => x.id === pid);
  if (!p) throw new HttpError(404, msg("playlistNotFound"));
  return p;
}

export async function getLibrary(): Promise<Library> {
  await mutations.catch(()=>{});
  return load();
}

export async function removeTrack(id: string, scope: "all" | "history" = "all"): Promise<Library> {
  return mutate(async lib=>{
  lib.history = lib.history.filter(t => t.id !== id);
  if (scope === "all") {
    lib.favorites = lib.favorites.filter(t => t.id !== id);
    for (const playlist of lib.playlists) {
      if (playlist.tracks.some(t => t.id === id)) {
        playlist.tracks = playlist.tracks.filter(t => t.id !== id);
        playlist.updatedAt = Date.now();
      }
    }
  }
  await persist();
  return lib;
  });
}

export async function addFavorite(track: Track): Promise<Track[]> {
  return mutate(async lib=>{
  lib.favorites = [track, ...lib.favorites.filter((t) => t.id !== track.id)];
  await persist();
  return lib.favorites;
  });
}

/** Adds many at once (in the given order, on top), skipping ones already there. */
export async function addFavorites(tracks: Track[]): Promise<Track[]> {
  return mutate(async lib=>{
  const seen = new Set(lib.favorites.map((t) => t.id));
  const added = tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
  lib.favorites = [...added, ...lib.favorites];
  await persist();
  return lib.favorites;
  });
}

export async function removeFavorite(id: string): Promise<Track[]> {
  return mutate(async lib=>{
  lib.favorites = lib.favorites.filter((t) => t.id !== id);
  await persist();
  return lib.favorites;
  });
}

export async function pushHistory(track: Track): Promise<Track[]> {
  return mutate(async lib=>{
  lib.history = [track, ...lib.history.filter((t) => t.id !== track.id)].slice(0, HISTORY_LIMIT);
  await persist();
  return lib.history;
  });
}

export async function createPlaylist(name: string, tracks: Track[] = []): Promise<Playlist> {
  return mutate(async lib=>{
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(400, msg("playlistNameRequired"));
  // Importing the same playlist twice (a double tap, a retry) should open the one already there, not add another.
  const existing = tracks.length
    ? lib.playlists.find(
        (p) => p.name === clean && p.tracks.length === tracks.length && p.tracks.every((t, i) => t.id === tracks[i]!.id),
      )
    : undefined;
  if (existing) return existing;
  const now = Date.now();
  const playlist: Playlist = { id: randomUUID(), name: clean, createdAt: now, updatedAt: now, tracks };
  lib.playlists.unshift(playlist);
  await persist();
  return findPlaylist(lib,playlist.id);
  });
}

export async function renamePlaylist(pid: string, name: string): Promise<Playlist> {
  return mutate(async lib=>{
  const p = findPlaylist(lib, pid);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(400, msg("playlistNameRequired"));
  p.name = clean;
  p.updatedAt = Date.now();
  await persist();
  return findPlaylist(lib,p.id);
  });
}

export async function deletePlaylist(pid: string): Promise<void> {
  return mutate(async lib=>{
  findPlaylist(lib, pid);
  lib.playlists = lib.playlists.filter((p) => p.id !== pid);
  await persist();
  });
}

export async function addToPlaylist(pid: string, tracks: Track | Track[]): Promise<Playlist> {
  return mutate(async lib=>{
  const p = findPlaylist(lib, pid);
  for (const track of Array.isArray(tracks) ? tracks : [tracks]) {
    if (!p.tracks.some((t) => t.id === track.id)) p.tracks.push(track);
  }
  p.updatedAt = Date.now();
  await persist();
  return findPlaylist(lib,p.id);
  });
}

export async function removeFromPlaylist(pid: string, trackId: string): Promise<Playlist> {
  return mutate(async lib=>{
  const p = findPlaylist(lib, pid);
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
  p.updatedAt = Date.now();
  await persist();
  return findPlaylist(lib,p.id);
  });
}

// Backup import: a library exported from any Musike instance (web, desktop, another computer).

const MAX_PLAYLISTS = 1000;
const MAX_TRACKS = 5000;

/** Keeps the valid tracks of an untrusted list, without duplicates. */
function cleanTracks(input: unknown, limit = MAX_TRACKS): Track[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const raw of input.slice(0, limit * 2)) {
    try {
      const t = sanitizeTrack(raw);
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= limit) break;
    } catch {
      // skip invalid entries instead of rejecting the whole backup
    }
  }
  return out;
}

function cleanLibrary(input: unknown): Library {
  const lib = (input ?? {}) as Record<string, unknown>;
  const playlists = (Array.isArray(lib.playlists) ? lib.playlists : []).slice(0, MAX_PLAYLISTS).flatMap((raw): Playlist[] => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const name = str(p.name, 80).trim();
    if (!name) return [];
    const now = Date.now();
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : now);
    const id = str(p.id, 64);
    return [{ id: /^[\w-]{8,64}$/.test(id) ? id : randomUUID(), name, createdAt: num(p.createdAt), updatedAt: num(p.updatedAt), tracks: cleanTracks(p.tracks) }];
  });
  return { favorites: cleanTracks(lib.favorites), playlists, history: cleanTracks(lib.history, HISTORY_LIMIT) };
}

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  favoritesAdded: number;
}

/**
 * "merge" adds what is missing and never deletes (playlists match by id, then by name).
 * "replace" swaps the whole library for the backup's.
 */
export async function importLibrary(input: unknown, mode: "merge" | "replace"): Promise<ImportResult> {
  const incoming = cleanLibrary(input);
  return mutate(async lib=>{
  const result: ImportResult = { playlistsAdded: 0, playlistsMerged: 0, tracksAdded: 0, favoritesAdded: 0 };

  if (mode === "replace") {
    state = incoming;
    result.playlistsAdded = incoming.playlists.length;
    result.favoritesAdded = incoming.favorites.length;
    result.tracksAdded = incoming.playlists.reduce((n, p) => n + p.tracks.length, 0);
    await persist();
    return result;
  }

  const union = (mine: Track[], theirs: Track[]) => {
    const have = new Set(mine.map((t) => t.id));
    const added = theirs.filter((t) => !have.has(t.id));
    return { list: [...mine, ...added], added: added.length };
  };

  const fav = union(lib.favorites, incoming.favorites);
  lib.favorites = fav.list;
  result.favoritesAdded = fav.added;

  for (const p of incoming.playlists) {
    const match =
      lib.playlists.find((x) => x.id === p.id) ??
      lib.playlists.find((x) => x.name.toLocaleLowerCase("pt-BR") === p.name.toLocaleLowerCase("pt-BR"));
    if (match) {
      const merged = union(match.tracks, p.tracks);
      if (!merged.added) continue; // already had every track: nothing changed
      match.tracks = merged.list.slice(0, MAX_TRACKS);
      match.updatedAt = Date.now();
      result.tracksAdded += merged.added;
      result.playlistsMerged++;
    } else {
      lib.playlists.push(p);
      result.tracksAdded += p.tracks.length;
      result.playlistsAdded++;
    }
  }

  lib.history = union(lib.history, incoming.history).list.slice(0, HISTORY_LIMIT);
  await persist();
  return result;
  });
}
