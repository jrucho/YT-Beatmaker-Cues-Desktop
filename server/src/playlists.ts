import { Mixins } from "youtubei.js";
import { withClient, text, toTrack } from "./search.js";
import { HttpError, type Track } from "./types.js";
import { msg, type Lang } from "./i18n.js";

export interface CatalogPlaylist {
  id: string;
  title: string;
  author: string;
  thumb: string;
}

export interface CatalogPlaylistPage extends CatalogPlaylist {
  tracks: Track[];
  truncated: boolean;
  complete?: boolean;
}

export interface CatalogPlaylistSearch {
  playlists: CatalogPlaylist[];
  /** Pass back to fetch the next page of YouTube results. */
  cursor?: string;
}

/** Match the studio library limit and YouTube's public playlist maximum. */
const MAX_PLAYLIST_TRACKS = 5_000;
const MAX_PLAYLIST_PAGES = 200;
const SEARCH_TTL_MS = 10 * 60_000;
const MAX_SEARCH_FEEDS = 60;

interface PlaylistEntry {
  key: string;
  info: CatalogPlaylist;
  page: any;
  tracks: Map<string,Track>;
  pages: number;
  complete: boolean;
  truncated: boolean;
  createdAt: number;
  work: Promise<void> | null;
  listeners: Set<{progress(page:CatalogPlaylistPage):void;resolve(page:CatalogPlaylistPage):void;reject(error:unknown):void}>;
}
const cache=new Map<string,PlaylistEntry>();
const initial=new Map<string,Promise<PlaylistEntry>>();
/** YouTube search continuations are tied to the session that produced them, so keep the feed server-side. */
const searchFeeds = new Map<string, {
  feed: Mixins.Feed;
  key: string;
  expires: number;
  pending?: Promise<CatalogPlaylistSearch>;
}>();
let searchToken=0;
const snapshot=(entry:PlaylistEntry):CatalogPlaylistPage=>({...entry.info,tracks:[...entry.tracks.values()],truncated:entry.truncated,complete:entry.complete});
const aborted=()=>new DOMException('Aborted','AbortError');
function append(entry:PlaylistEntry,page:any){
  entry.page=page;++entry.pages;
  let consumed=0;
  for(const item of page.items as any[]){
    ++consumed;if(item.is_playable===false)continue;
    const track=toTrack(item,'video');if(track)entry.tracks.set(track.id,track);
    if(entry.tracks.size>=MAX_PLAYLIST_TRACKS)break;
  }
  entry.complete=!page.has_continuation||entry.tracks.size>=MAX_PLAYLIST_TRACKS||entry.pages>=MAX_PLAYLIST_PAGES;
  entry.truncated=entry.complete&&(!!page.has_continuation||consumed<page.items.length);
}
async function entryFor(value:string,lang?:Lang):Promise<PlaylistEntry>{
  const id=playlistId(value),key=(lang??'default')+':'+id;
  const previous=cache.get(key);
  if(previous&&(previous.work||Date.now()-previous.createdAt<5*60_000))return previous;
  if(initial.has(key))return initial.get(key)!;
  const task=(async()=>{
    const page=await withClient(yt=>yt.getPlaylist(id),lang),info=page.info;
    const entry:PlaylistEntry={key,info:{id,title:text(info.title)||'YouTube playlist',author:text(info.author?.name),thumb:info.thumbnails?.[0]?.url??''},page,tracks:new Map(),pages:0,complete:false,truncated:false,createdAt:Date.now(),work:null,listeners:new Set()};
    append(entry,page);cache.delete(key);cache.set(key,entry);
    for(const [oldKey,old] of cache){if(cache.size<=8)break;if(!old.work&&oldKey!==key)cache.delete(oldKey);}
    return entry;
  })().finally(()=>initial.delete(key));
  initial.set(key,task);return task;
}
function continueEntry(entry:PlaylistEntry){
  if(entry.work)return;
  entry.work=(async()=>{
    while(!entry.complete&&entry.listeners.size){
      append(entry,await entry.page.getContinuation());
      const page=snapshot(entry);
      for(const listener of [...entry.listeners]){try{listener.progress(page);}catch(error){listener.reject(error);}}
    }
    if(entry.complete){
      if(!entry.tracks.size)throw new HttpError(404,'This playlist has no playable public tracks.');
      for(const listener of [...entry.listeners])listener.resolve(snapshot(entry));
    }
  })().catch(error=>{cache.delete(entry.key);for(const listener of [...entry.listeners])listener.reject(error);}).finally(()=>{
    entry.work=null;if(!entry.complete&&entry.listeners.size)continueEntry(entry);
  });
}

const PLAYLIST_ID = /^[\w-]{10,150}$/;

export function playlistId(value: string): string {
  let id = value.trim();
  if (/^https?:\/\//i.test(id)) {
    const url = new URL(id);
    if (!/(^|\.)youtube\.com$|^youtu\.be$/i.test(url.hostname)) throw new HttpError(400, "Use a YouTube playlist link.");
    id = url.searchParams.get("list") ?? "";
  }
  id = id.replace(/^VL/, "");
  if (!PLAYLIST_ID.test(id)) throw new HttpError(400, "Invalid playlist ID.");
  return id;
}

function catalogPlaylists(result: Mixins.Feed): CatalogPlaylist[] {
  const found = new Map<string, CatalogPlaylist>();
  for (const item of result.playlists as any[]) {
    const id = String(item.id ?? item.content_id ?? "").replace(/^VL/, "");
    const title = text(item.title ?? item.metadata?.title);
    if (!PLAYLIST_ID.test(id) || !title || found.has(id)) continue;
    const thumbs = item.thumbnails ?? item.content_image?.primary_thumbnail?.image ?? item.content_image?.image ?? [];
    found.set(id, {
      id,
      title,
      author: text(item.author?.name ?? item.author ?? item.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text),
      thumb: thumbs[0]?.url ?? "",
    });
  }
  return [...found.values()];
}

function rememberSearch(feed: Mixins.Feed, key: string): string {
  const token = `${Date.now().toString(36)}-${(++searchToken).toString(36)}`;
  const now = Date.now();
  for (const [id, saved] of searchFeeds) if (saved.expires <= now) searchFeeds.delete(id);
  while (searchFeeds.size >= MAX_SEARCH_FEEDS) {
    const oldest = searchFeeds.keys().next().value;
    if (!oldest) break;
    searchFeeds.delete(oldest);
  }
  searchFeeds.set(token, { feed, key, expires: now + SEARCH_TTL_MS });
  return token;
}

function playlistSearchPage(feed: Mixins.Feed, key: string): CatalogPlaylistSearch {
  return { playlists: catalogPlaylists(feed), cursor: feed.has_continuation ? rememberSearch(feed, key) : undefined };
}

/** One page of YouTube playlist search, or the next page when `cursor` is given. */
export async function searchPlaylists(query: string, lang?: Lang, cursor?: string): Promise<CatalogPlaylistSearch> {
  const key = JSON.stringify([query, lang]);
  if (cursor) {
    const saved = searchFeeds.get(cursor);
    if (!saved || saved.key !== key || saved.expires <= Date.now()) throw new HttpError(410, msg("searchExpired"));
    // Replaying a cursor after a retry or double tap must not skip a page.
    saved.pending ??= saved.feed.getContinuationData().then((page) => {
      if (!page) throw new Error("Missing playlist continuation");
      // The search wrapper assumes that every command is a reload, but YouTube
      // sends append and reload together (and sometimes sends them as actions
      // or endpoints). Feed reads the parsed nodes from all those envelopes.
      return playlistSearchPage(new Mixins.Feed(saved.feed.actions, page, true), key);
    }).catch(() => {
      saved.pending = undefined;
      throw new HttpError(502, msg("playlistSearchMoreUnavailable"));
    });
    return saved.pending;
  }
  if (/^https?:\/\//i.test(query)) {
    return { playlists: [(await entryFor(query, lang)).info] }; // Metadata needs one page, not the entire playlist.
  }
  const feed = await withClient(yt => yt.search(query, { type: "playlist" }), lang);
  return playlistSearchPage(feed, key);
}

export async function getPlaylist(value:string,lang?:Lang,options:{signal?:AbortSignal;onProgress?:(page:CatalogPlaylistPage)=>void}={}):Promise<CatalogPlaylistPage>{
  if(options.signal?.aborted)throw aborted();
  const entry=await entryFor(value,lang);
  if(options.signal?.aborted)throw aborted();
  options.onProgress?.(snapshot(entry));
  if(options.signal?.aborted)throw aborted();
  if(entry.complete){if(!entry.tracks.size)throw new HttpError(404,'This playlist has no playable public tracks.');return snapshot(entry);}
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{entry.listeners.delete(listener);options.signal?.removeEventListener('abort',cancel);};
    const listener={progress:(page:CatalogPlaylistPage)=>options.onProgress?.(page),resolve:(page:CatalogPlaylistPage)=>{cleanup();resolve(page);},reject:(error:unknown)=>{cleanup();reject(error);}};
    const cancel=()=>listener.reject(aborted());
    entry.listeners.add(listener);options.signal?.addEventListener('abort',cancel,{once:true});
    continueEntry(entry);
  });
}
