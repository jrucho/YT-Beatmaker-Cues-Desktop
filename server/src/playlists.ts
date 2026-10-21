import { withClient, text, toTrack } from "./search.js";
import { HttpError, type Track } from "./types.js";
import type { Lang } from "./i18n.js";

export interface CatalogPlaylist {
  id: string;
  title: string;
  author: string;
  thumb: string;
}

export interface CatalogPlaylistPage extends CatalogPlaylist {
  tracks: Track[];
  truncated: boolean;
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

export async function searchPlaylists(query: string, lang?: Lang): Promise<CatalogPlaylist[]> {
  if (/^https?:\/\//i.test(query)) {
    const page = await getPlaylist(query, lang);
    return [{ id: page.id, title: page.title, author: page.author, thumb: page.thumb }];
  }
  const result = await withClient(yt => yt.search(query, { type: "playlist" }), lang);
  return result.playlists.flatMap((item: any): CatalogPlaylist[] => {
    const id = (item.id ?? item.content_id ?? "").replace(/^VL/, "");
    const title = text(item.title ?? item.metadata?.title);
    if (!PLAYLIST_ID.test(id) || !title) return [];
    const thumbs = item.thumbnails ?? item.content_image?.primary_thumbnail?.image ?? item.content_image?.image ?? [];
    return [{ id, title, author: text(item.author?.name ?? item.author ?? item.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text), thumb: thumbs[0]?.url ?? "" }];
  }).slice(0, 30);
}

export async function getPlaylist(value: string, lang?: Lang): Promise<CatalogPlaylistPage> {
  const id = playlistId(value);
  let page = await withClient(yt => yt.getPlaylist(id), lang);
  const info = page.info;
  const tracks = new Map<string, Track>();
  let truncated = false;
  for (let batch = 0; batch < 20; batch++) {
    let consumed = 0;
    for (const item of page.items as any[]) {
      consumed++;
      if (item.is_playable === false) continue;
      const track = toTrack(item, "video");
      if (track) tracks.set(track.id, track);
      if (tracks.size >= 500) break;
    }
    if (tracks.size >= 500 || !page.has_continuation || batch === 19) {
      truncated = page.has_continuation || consumed < page.items.length;
      break;
    }
    page = await page.getContinuation();
  }
  if (!tracks.size) throw new HttpError(404, "This playlist has no playable public tracks.");
  return { id, title: text(info.title) || "YouTube playlist", author: text(info.author?.name), thumb: info.thumbnails?.[0]?.url ?? "", tracks: [...tracks.values()], truncated };
}
