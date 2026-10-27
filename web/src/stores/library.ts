import { create } from "zustand";
import { getT } from "../i18n";
import { api } from "../lib/api";
import type { Library, Playlist, Track } from "../lib/types";
import { toast } from "./ui";

interface LibraryState extends Library {
  status: "idle" | "loading" | "ready" | "error";
  load: (quiet?:boolean) => Promise<void>;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (t: Track) => Promise<void>;
  addFavorites: (tracks: Track[]) => Promise<void>;
  recordPlay: (t: Track) => void;
  createPlaylist: (name: string, tracks?: Track[]) => Promise<Playlist | null>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (id: string, t: Track | Track[]) => Promise<void>;
  removeFromPlaylist: (id: string, trackId: string) => Promise<void>;
  removeTrack: (id: string, scope?: "all" | "history") => Promise<void>;
}

const replacePlaylist = (list: Playlist[], p: Playlist) => list.map((x) => (x.id === p.id ? p : x));
const favoriteIndexes=new WeakMap<Track[],Set<string>>();
export function favoriteIds(tracks:Track[]){let index=favoriteIndexes.get(tracks);if(!index){index=new Set(tracks.map(track=>track.id));favoriteIndexes.set(tracks,index);}return index;}

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: [],
  playlists: [],
  history: [],
  status: "idle",

  removeTrack: async (id, scope = "all") => {
    try {
      const lib = await api.removeLibraryTrack(id, scope);
      set(lib);
      toast(getT().toasts.removedFromLibrary);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  load: async (quiet=false) => {
    if(!quiet)set({ status: "loading" });
    try {
      const lib = await api.library();
      set({ ...lib, status: "ready" });
    } catch {
      set({ status: "error" });
    }
  },

  isFavorite: (id) => favoriteIds(get().favorites).has(id),

  toggleFavorite: async (track) => {
    const prev = get().favorites;
    const on = !prev.some((t) => t.id === track.id);
    // Optimistic: the heart responds instantly, then reconciles with the server.
    set({ favorites: on ? [track, ...prev] : prev.filter((t) => t.id !== track.id) });
    try {
      const { favorites } = on ? await api.addFavorite(track) : await api.removeFavorite(track.id);
      set({ favorites });
      toast(on ? getT().toasts.addedFavorite : getT().toasts.removedFavorite);
    } catch (e) {
      set({ favorites: prev });
      toast((e as Error).message, "error");
    }
  },

  addFavorites: async (tracks) => {
    const prev = get().favorites;
    const ids=favoriteIds(prev);
    const fresh = tracks.filter((t) => !ids.has(t.id));
    if (!fresh.length) return toast(getT().toasts.allAlreadyFavorites);
    set({ favorites: [...fresh, ...prev] });
    try {
      const { favorites } = await api.addFavorites(fresh);
      set({ favorites });
      toast(fresh.length === 1 ? getT().toasts.addedFavorite : getT().toasts.addedFavorites(fresh.length));
    } catch (e) {
      set({ favorites: prev });
      toast((e as Error).message, "error");
    }
  },

  recordPlay: (track) => {
    set((s) => ({ history: [track, ...s.history.filter((t) => t.id !== track.id)].slice(0, 60) }));
    api.pushHistory(track).catch(() => {});
  },

  createPlaylist: async (name, tracks = []) => {
    try {
      const p = await api.createPlaylist(name, tracks);
      set((s) => ({ playlists: s.playlists.some((x) => x.id === p.id) ? s.playlists : [p, ...s.playlists] }));
      toast(getT().toasts.playlistCreated(p.name));
      return p;
    } catch (e) {
      toast((e as Error).message, "error");
      return null;
    }
  },

  renamePlaylist: async (id, name) => {
    try {
      const p = await api.renamePlaylist(id, name);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  deletePlaylist: async (id) => {
    const prev = get().playlists;
    set({ playlists: prev.filter((p) => p.id !== id) });
    try {
      await api.deletePlaylist(id);
      toast(getT().toasts.playlistDeleted);
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },

  addToPlaylist: async (id, tracks) => {
    try {
      const before = get().playlists.find((p) => p.id === id)?.tracks.length ?? 0;
      const p = await api.addToPlaylist(id, tracks);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
      const added = p.tracks.length - before;
      const t = getT();
      if (!Array.isArray(tracks) || added === 1) toast(t.toasts.addedTo(p.name));
      else toast(added ? t.toasts.addedManyTo(added, p.name) : t.toasts.allAlreadyIn(p.name));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  removeFromPlaylist: async (id, trackId) => {
    const prev = get().playlists;
    set({
      playlists: prev.map((p) => (p.id === id ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p)),
    });
    try {
      const p = await api.removeFromPlaylist(id, trackId);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },
}));

// Pick up another app/host's committed edits when this view becomes active.
let refreshing=false;
const refreshSharedLibrary=()=>{
  if(refreshing||document.visibilityState==='hidden'||useLibrary.getState().status!=='ready')return;
  refreshing=true;void useLibrary.getState().load(true).finally(()=>{refreshing=false;});
};
window.addEventListener('focus',refreshSharedLibrary);
document.addEventListener('visibilitychange',refreshSharedLibrary);
