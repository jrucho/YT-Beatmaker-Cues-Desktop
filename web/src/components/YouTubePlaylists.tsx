import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, PlaylistIcon, PlayIcon } from "@phosphor-icons/react";
import { api, type CatalogPlaylist, type CatalogPlaylistPage } from "../lib/api";
import type { Playlist, Track } from "../lib/types";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../player/player";
import { Artwork } from "./Artwork";
import { Modal } from "./Modal";
import { useNavigate } from "react-router";
import { paths } from "../lib/routes";
import "./youtubePlaylists.css";

export function YouTubePlaylists({ query, onImported, onPreview, layout = "grid" }: { query: string; onImported?(playlist: Playlist): void; onPreview?(track: Track): void; layout?: "grid" | "row" }) {
  const [results, setResults] = useState<CatalogPlaylist[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<CatalogPlaylist | null>(null);
  const [page, setPage] = useState<CatalogPlaylistPage | null>(null);
  const [pageError, setPageError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const playlists = useLibrary(s => s.playlists);
  const navigate = useNavigate();
  const openSaved = (playlist: Playlist) => onImported ? onImported(playlist) : navigate(paths.playlist(playlist.id));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setResults([]); setError("");
    if (!query.trim()) { setBusy(false); return; }
    setBusy(true);
    api.searchPlaylists(query, controller.signal).then(value => { if (!controller.signal.aborted) setResults(value); }).catch(e => {
      if (!controller.signal.aborted) setError(e.message);
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [query, retry]);
  useEffect(() => {
    setPage(null); setPageError("");
    if (!selected) return;
    const controller = new AbortController();
    api.youtubePlaylist(selected.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value);
    }).catch(e => { if (!controller.signal.aborted) setPageError(e.message); });
    return () => controller.abort();
  }, [selected, retry]);

  const existing = page && playlists.find(p => p.name === page.title.trim().slice(0, 80) && p.tracks.length === page.tracks.length && page.tracks.every(t => p.tracks.some(s => s.id === t.id)));
  const preview = (track: Track) => {
    if (onPreview) onPreview(track);
    else { usePlayer.getState().setAutoRadio(false); usePlayer.getState().playList([track]); }
  };
  async function save() {
    // A ref, not the state: a quick second tap lands before React re-renders and would create the playlist twice.
    if (!page || savingRef.current) return;
    if (existing) { setSelected(null); openSaved(existing); return; }
    savingRef.current = true;
    setSaving(true);
    const saved = await useLibrary.getState().createPlaylist(page.title, page.tracks);
    if (mounted.current) {
      savingRef.current = false;
      setSaving(false);
      if (saved) { setSelected(null); openSaved(saved); }
    }
  }

  return <div className={`yt-playlists ${layout === "row" ? "yt-playlists-row" : ""}`} aria-label="YouTube playlist results" aria-busy={busy}>
    {busy && <p role="status">Searching playlists…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(n => n + 1)}>Retry playlist search</button></div>}
    {!busy && !error && !results.length && <p>{query.trim() ? "No playlists found." : "Search YouTube playlists or paste a playlist link."}</p>}
    <div className="yt-playlist-grid" tabIndex={layout === "row" ? 0 : undefined} aria-label={layout === "row" ? "Scroll YouTube playlists" : undefined}>{results.map(p => <button type="button" className="yt-playlist-result" key={p.id} aria-label={`Open YouTube playlist ${p.title}`} onClick={() => setSelected(p)}>
      {p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <PlaylistIcon size={28} />}
      <span><strong>{p.title}</strong><small>{p.author || "YouTube playlist"}</small></span><ArrowRightIcon size={15} />
    </button>)}</div>
    <Modal open={!!selected} title={selected?.title || "YouTube playlist"} onClose={() => { if (!saving) setSelected(null); }}>
      {!page && !pageError && <p role="status">Loading tracks…</p>}
      {pageError && <div role="alert"><p>{pageError}</p><button type="button" onClick={() => setRetry(n => n + 1)}>Retry loading playlist</button></div>}
      {page && <>
        <div className="mb-3 flex items-center justify-between gap-3"><span className="text-sm text-fg-2">{page.tracks.length} tracks{page.truncated ? " · first 500 playable tracks" : ""}</span><button type="button" disabled={saving} onClick={() => void save()} className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40">{saving ? "Adding…" : existing ? "Open in library" : "Add playlist to library"}</button></div>
        <div className="scroll-area max-h-[45dvh] overflow-y-auto">{page.tracks.map(t => <button key={t.id} type="button" aria-label={`Preview playlist track ${t.title}`} onClick={() => preview(t)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-surface-3">
          <Artwork src={t.thumb} className="size-10 shrink-0 rounded-md" /><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{t.title}</strong><small className="text-fg-2">{t.artist}</small></span><PlayIcon size={16} />
        </button>)}</div>
      </>}
    </Modal>
  </div>;
}
