import { CaretRightIcon, CheckIcon, FileAudioIcon, ListPlusIcon } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import { isLocalAudio, type Playlist, type Track } from "../lib/types";
import { libraryTrackChoices, localAudioStatus } from "../mobile/libraryTools";
import { pickAudioFiles } from "../mobile/mediaEditing";
import { useLibrary } from "../stores/library";
import { Cover } from "./Cover";
import { Modal } from "./Modal";
import { VirtualList } from "./VirtualList";

const option = "flex min-h-11 items-center gap-2 rounded-xl bg-surface-3 px-3 py-2 text-left text-sm font-medium disabled:opacity-40";

export function PlaylistAddTracks({ playlist, onClose }: { playlist: Playlist; onClose: () => void }) {
  const t = useT();
  const labels = t.libraryTools.add;
  const add = useLibrary((s) => s.addToPlaylist);
  const working = useRef(false);
  const [busy, setBusy] = useState<"files" | "library" | "saving" | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [choices, setChoices] = useState<ReturnType<typeof libraryTrackChoices> | null>(null);
  const [scope, setScope] = useState<"playlists" | "tracks">("playlists");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const source = choices?.playlists.find(({ playlist }) => playlist.id === sourceId);
  const browsePlaylists = scope === "playlists" && !source;
  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    if (browsePlaylists) return [];
    return (source?.tracks ?? choices?.tracks ?? []).filter((track) => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(needle));
  }, [browsePlaylists, choices, needle, source]);
  const visiblePlaylists = useMemo(
    () => browsePlaylists ? (choices?.playlists ?? []).filter(({ playlist }) => playlist.name.toLocaleLowerCase().includes(needle)) : [],
    [browsePlaylists, choices, needle],
  );

  function changeScope(next: typeof scope) {
    setScope(next);
    setSourceId(null);
    setQuery("");
  }

  async function run(stage: NonNullable<typeof busy>, fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(stage);
    setIssues([]);
    try {
      await fn();
    } catch (error) {
      setIssues([(error as Error).message]);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  async function save(tracks: Track[], problems: string[], fromFiles = false) {
    if (tracks.length) {
      const saved = await add(playlist.id, tracks);
      const present = new Set(saved?.tracks.map((track) => track.id));
      const skipped = tracks.filter((track) => !present.has(track.id)).length;
      if (skipped) {
        problems.push(labels.notAdded(skipped));
        if (fromFiles) problems.push(labels.retained);
      }
      if (saved && !problems.length) return onClose();
    }
    setIssues(problems);
  }

  function openFiles() {
    void run("files", async () => {
      const { tracks, errors } = await pickAudioFiles(true);
      await save(tracks, (errors ?? []).map(({ file, message }) => `${file}: ${message}`), true);
    });
  }

  function openLibrary() {
    void run("library", async () => {
      const [library, audio] = await Promise.all([api.library(), localAudioStatus()]);
      setChoices(libraryTrackChoices(library, audio, playlist.id));
      changeScope("playlists");
      setSelected(new Set());
    });
  }

  return (
    <Modal open title={labels.title} onClose={() => { if (!working.current) onClose(); }}>
      <div className="flex flex-col gap-3">
        <p className="break-words text-sm text-fg-2">{labels.destination(playlist.name)}</p>
        {choices ? <>
          <div role="tablist" aria-label={labels.library} className="flex gap-2">
            {(["playlists", "tracks"] as const).map((tab) => (
              <button key={tab} type="button" role="tab" aria-selected={scope === tab} disabled={!!busy}
                onClick={() => changeScope(tab)} className={cn(option, scope === tab && "bg-accent-soft text-accent-text")}>
                {tab === "playlists" ? labels.playlists : labels.allTracks}
              </button>
            ))}
          </div>
          {source && <p className="truncate text-sm font-semibold">{source.playlist.name}</p>}
          <input type="search" aria-label={browsePlaylists ? labels.searchPlaylists : labels.search}
            placeholder={browsePlaylists ? labels.searchPlaylists : labels.search} value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 rounded-full border border-line-strong bg-surface-1 px-4 text-base" />
          <div key={sourceId ?? scope} className="scroll-area max-h-[32dvh] overflow-y-auto">
            {browsePlaylists ? (visiblePlaylists.length ? <VirtualList items={visiblePlaylists} itemKey={({ playlist }) => playlist.id}
              renderItem={({ playlist: from, tracks }, _index, virtual) => <li {...virtual}>
                <button type="button" disabled={!!busy} onClick={() => { setSourceId(from.id); setQuery(""); }}
                  className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left hover:bg-surface-3">
                  <Cover kind="playlist" tracks={from.tracks} cover={from.cover} className="size-9 rounded-md" iconSize={16} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{from.name}</span>
                    <span className="block text-xs text-fg-2">{t.common.tracks(tracks.length)}</span>
                  </span>
                  <CaretRightIcon size={16} className="shrink-0 text-fg-3" />
                </button>
              </li>} /> : <p className="py-2 text-sm text-fg-2">{choices.playlists.length ? labels.noPlaylistMatches : labels.noPlaylists}</p>)
              : visible.length ? <VirtualList items={visible} itemKey={(track) => track.id}
              renderItem={(track, _index, virtual) => <li {...virtual}>
                <button type="button" role="checkbox" aria-checked={selected.has(track.id)} disabled={!!busy}
                  onClick={() => setSelected((previous) => {
                    const next = new Set(previous);
                    if (!next.delete(track.id)) next.add(track.id);
                    return next;
                  })}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left hover:bg-surface-3">
                  <span className="grid size-5 shrink-0 place-items-center rounded border border-line-strong text-accent-text">
                    {selected.has(track.id) && <CheckIcon size={14} weight="bold" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{track.title}</span>
                    <span className="block truncate text-xs text-fg-2">
                      {isLocalAudio(track.id) ? t.libraryTools.localAudio : track.artist || t.common.youtube}
                    </span>
                  </span>
                </button>
              </li>} /> : <p className="py-2 text-sm text-fg-2">{labels.noResults}</p>}
          </div>
          <div className="flex justify-between gap-2">
            <button type="button" disabled={!!busy} className={option} onClick={() => {
              if (source) changeScope("playlists");
              else { setChoices(null); setIssues([]); }
            }}>
              {t.common.back}
            </button>
            {(!browsePlaylists || selected.size > 0) && <button type="button" disabled={!!busy || !selected.size} className={cn(option, "bg-accent text-accent-ink")}
              onClick={() => void run("saving", () => save(choices.tracks.filter((track) => selected.has(track.id)), []))}>
              {labels.addSelected(selected.size)}
            </button>}
          </div>
        </> : <>
          <button type="button" className={option} disabled={!!busy} onClick={openFiles}><FileAudioIcon size={18} /> {labels.files}</button>
          <button type="button" className={option} disabled={!!busy} onClick={openLibrary}><ListPlusIcon size={18} /> {labels.library}</button>
        </>}
        {busy && <p role="status" className="text-sm text-fg-2">{busy === "files" ? labels.importing : labels.working}</p>}
        {issues.length > 0 && <ul role="alert" className="scroll-area max-h-[16dvh] overflow-y-auto break-words text-sm text-danger">
          {issues.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>}
      </div>
    </Modal>
  );
}
