import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowCounterClockwise, ArrowSquareOut, CircleNotch, DownloadSimple, FolderOpen, GearSix, GridFour, Info, List, MagnifyingGlass, MusicNotes, Pause, Play, PlaylistIcon, Plus, Shuffle, SlidersHorizontal, SpeakerHigh, TrashIcon, X } from "@phosphor-icons/react";
import { api, saveFile } from "../lib/api";
import { desktop } from "../lib/desktop";
import type { Track } from "../lib/types";
import { selectCurrent, usePlayer, useStatusText, videoEl } from "../player/player";
import { useLibrary } from "../stores/library";
import { openSettings } from "../stores/system";
import { toast, useUi } from "../stores/ui";
import { LogoMark } from "../components/Brand";
import { AddToPlaylistDialog, NamePlaylistDialog } from "../components/Dialogs";
import { SettingsDialog } from "../components/SettingsDialog";
import { Toasts } from "../components/Toasts";
import { YouTubePlaylists } from "../components/YouTubePlaylists";
import { loadBeatmaker, setEngineBank, type Engine } from "./runtime";
import { CONTROLLER_PRESETS, readControllerPreset, saveControllerPreset } from "../native/controllerMapping";
import { padFeedback, usePadFeedback } from "../mobile/padFeedback";
import "./beatmaker.css";

const BANKS = "ABCDEFGHIJ".split("");
const cueKey = (i: number) => i === 9 ? "0" : String(i + 1);
const time = (s: number) => `${Math.floor((s || 0) / 60)}:${Math.floor((s || 0) % 60).toString().padStart(2, "0")}`;

export function Beatmaker({ onBrowse, onDiscover }: { onBrowse(): void; onDiscover(): void }) {
  const library = useLibrary();
  const p = usePlayer();
  const track = usePlayer(selectCurrent);
  const status = useStatusText();
  const [bank, setBank] = useState(() => { const saved = localStorage.getItem("musike:studio:bank"); return saved && BANKS.includes(saved) ? saved : "A"; });
  const [name, setName] = useState(() => localStorage.getItem("musike:studio:name") || "Untitled_Session");
  const [source, setSource] = useState("all");
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const openAddToPlaylist = useUi((s) => s.openAddToPlaylist);
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState("songs");
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [results, setResults] = useState<Track[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [list, setList] = useState(false);
  const [guide, setGuide] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [cues, setCues] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const feedback = usePadFeedback();
  const [pitch, setPitch] = useState(0);
  const [rateLabel, setRateLabel] = useState("PITCH");
  const [midiPreset, setMidiPreset] = useState(() => readControllerPreset().id);
  const padCount = CONTROLLER_PRESETS.find(preset => preset.id === midiPreset)!.padToNote.length;
  const [midiOverwrite, setMidiOverwrite] = useState(false);
  const [rateLimits, setRateLimits] = useState([-50, 100]);
  const input = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    void library.load();
    if (window.musikeBeatmakerHost) window.musikeBeatmakerHost.active = true;
    setEngineBank(bank);
    const onEngineError = (event: Event) => toast((event as CustomEvent<string>).detail, "error");
    window.addEventListener("beatmaker-error", onEngineError);
    const onBank = (event: Event) => { setBank((event as CustomEvent<string>).detail); setActive(null); };
    const onMidiPad = (event: Event) => {
      const data = (event as CustomEvent<{ bank: string; pad: number; pressed: boolean }>).detail;
      setActive(data.pressed ? cueKey(data.pad - 1) : null);
      padFeedback({ bank: data.bank, pad: data.pad, phase: data.pressed ? "pressed" : "released" });
    };
    window.addEventListener("beatmaker-bank", onBank);
    window.addEventListener("beatmaker-midi-pad", onMidiPad);
    void loadBeatmaker().catch(err => toast((err as Error).message, "error"));
    const timer = setInterval(() => {
      const snapshot = window.musikeBeatmakerEngine?.snapshot();
      if (snapshot) { setCues(snapshot.cues); setPitch(snapshot.pitch); setEngineReady(snapshot.ready); setMediaReady(snapshot.mediaReady); setRateLabel(`${snapshot.rateTarget === "loop" ? "LOOP " : ""}${snapshot.rateMode}`); setRateLimits([snapshot.rateMin, snapshot.rateMax]); }
    }, 150);
    return () => {
      clearInterval(timer); controller.current?.abort(); window.removeEventListener("beatmaker-error", onEngineError);
      window.removeEventListener("beatmaker-bank", onBank);
      window.removeEventListener("beatmaker-midi-pad", onMidiPad);
      if (window.musikeBeatmakerHost) window.musikeBeatmakerHost.active = false;
      document.querySelectorAll<HTMLElement>(".looper-panel-container, .looper-midimap-container, #ytbm-mini-bar").forEach(el => { el.style.display = "none"; });
    };
  }, []);

  useEffect(() => {
    if (window.musikeBeatmakerHost) window.musikeBeatmakerHost.midiOverwrite = midiOverwrite;
  }, [midiOverwrite, engineReady]);

  function markNext() {
    if (!track || !engineReady || !mediaReady) return;
    for (const candidate of BANKS.slice(BANKS.indexOf(bank))) {
      const stored = candidate === bank ? window.musikeBeatmakerEngine!.snapshot().cues
        : JSON.parse(localStorage.getItem(`ytbm_cues_${track.id}:bank:${candidate}`) ?? "{}");
      for (let i = 0; i < padCount; i++) {
        const key = cueKey(i);
        if (stored[key] != null) continue;
        if (candidate !== bank) { setEngineBank(candidate); setBank(candidate); }
        trigger(key, true);
        return;
      }
    }
    toast("All remaining cue banks are full.");
  }

  useEffect(() => {
    localStorage.setItem("musike:studio:name", name);
  }, [name]);

  useEffect(() => { localStorage.setItem("musike:studio:bank", bank); }, [bank]);

  useEffect(() => {
    if (!guide) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setGuide(false); } };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [guide]);

  useEffect(() => {
    if (p.mediaKind === "video") video.current?.appendChild(videoEl);
    return () => { if (videoEl.parentElement === video.current) videoEl.remove(); };
  }, [p.mediaKind]);

  const tracks = source === "favorites" ? library.favorites : source === "history" ? library.history
    : source === "all" ? [...new Map([...library.favorites, ...library.history, ...library.playlists.flatMap(x => x.tracks)].map(t => [t.id, t])).values()]
    : library.playlists.find(x => x.id === source)?.tracks ?? [];
  const shown = results ?? tracks.filter(t => `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const selectedPlaylist = library.playlists.find(p => p.id === source);

  function selectCollection(id: string) {
    controller.current?.abort(); setSearching(false);
    setSource(id); setResults(null); setQuery(""); setSearchType("songs"); setPlaylistQuery("");
  }

  async function deleteCollection(id: string) {
    await library.deletePlaylist(id);
    if (source === id && !useLibrary.getState().playlists.some(p => p.id === id)) selectCollection("all");
  }

  async function removeTrack(t: Track) {
    if (selectedPlaylist) await library.removeFromPlaylist(source, t.id);
    else if (source === "favorites") await library.toggleFavorite(t);
    else await library.removeTrack(t.id, source === "history" ? "history" : "all");
  }

  async function search(value = query) {
    if (!value.trim()) { setResults(null); return; }
    controller.current?.abort();
    if (searchType === "playlists" || /[?&]list=/.test(value)) {
      setSearchType("playlists"); setPlaylistQuery(value.trim()); setSearching(false); setResults(null); return;
    }
    const abort = new AbortController(); controller.current = abort;
    setSearching(true);
    try { const found = await api.search(value.trim(), "song", abort.signal); if (!abort.signal.aborted) setResults(found); }
    catch (error) { if (!abort.signal.aborted) toast((error as Error).message, "error"); }
    finally { if (!abort.signal.aborted) setSearching(false); }
  }

  function launch(t: Track) {
    setActive(null);
    p.setAutoRadio(false);
    p.playList([t]);
  }

  function trigger(key: string, overwrite = false) {
    if (!track) { toast("Choose a track from the library or search YouTube Music first."); input.current?.focus(); return; }
    try { if (!engineReady) throw new Error("Studio is still loading."); window.musikeBeatmakerEngine!.cue(key, overwrite); setActive(key); }
    catch (error) { toast((error as Error).message, "error"); }
  }

  function engineAction(action: Exclude<keyof Engine, "snapshot" | "cue" | "remove" | "bank" | "pitch">) {
    try { if (!engineReady) throw new Error("Studio is still loading."); window.musikeBeatmakerEngine![action](); }
    catch (error) { toast((error as Error).message, "error"); }
  }

  async function saveSession() {
    try {
    const storage = Object.fromEntries(Object.keys(localStorage).filter(key => /^ytbm_cues_[\w-]{11}:bank:[A-J]$/.test(key)).map(key => [key, JSON.parse(localStorage.getItem(key)!)]));
    const sessionTracks = [...new Map([...library.favorites, ...library.history, ...library.playlists.flatMap(x => x.tracks), ...(track ? [track] : [])].map(t => [t.id, t])).values()];
    await saveFile(`${name.replace(/[^a-zA-Z0-9_-]/g, "_") || "Session"}.beatmaker.json`, JSON.stringify({ format: "musike-beatmaker", version: 1, name, bank, tracks: sessionTracks, cues: storage }, null, 2));
    toast("Session exported.");
    } catch (err) { toast((err as Error).message, "error"); }
  }

  async function importSession(selected?: File) {
    if (!selected) return;
    try {
      if (selected.size > 5_000_000) throw new Error("Session file is too large");
      const data = JSON.parse(await selected.text());
      if (data.format !== "musike-beatmaker" || data.version !== 1 || typeof data.cues !== "object" || !data.cues) throw new Error("Choose a valid Beatmaker session file");
      const entries = Object.entries(data.cues);
      for (const [key, value] of entries) {
        if (!/^ytbm_cues_[\w-]{11}:bank:[A-J]$/.test(key) || typeof value !== "object" || !value) throw new Error("Invalid cue data");
        for (const [pad, cue] of Object.entries(value)) {
          const seconds = typeof cue === "number" ? cue : (cue as { time?: number })?.time;
          if (!/^\d{1,3}$/.test(pad) || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error("Invalid cue time");
        }
      }
      for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));
      const imported: Track[] = Array.isArray(data.tracks) ? data.tracks.filter((t: Track) => t && /^[\w-]{11}$/.test(t.id) && typeof t.title === "string" && typeof t.artist === "string" && Number.isFinite(t.duration) && [t.thumb, t.art].every(url => typeof url === "string" && (!url || url.startsWith("https://")))) : [];
      if (imported.length && !await library.createPlaylist(typeof data.name === "string" ? data.name.slice(0, 100) : "Imported session", imported)) throw new Error("Cues restored, but the track playlist could not be saved. Retry loading the session.");
      if (typeof data.name === "string") setName(data.name.slice(0, 100));
      const nextBank = BANKS.includes(data.bank) ? data.bank : "A";
      setBank(nextBank); setEngineBank(nextBank);
      toast("Session loaded");
    } catch (err) { toast((err as Error).message, "error"); }
  }

  return (
    <div className={`bm-app ${desktop?.platform === "darwin" ? "bm-mac" : ""}`} data-engine-ready={engineReady}>
      {desktop && <div className="bm-titlebar app-drag"><span>BEATMAKER CUES</span><span>v{__APP_VERSION__}</span></div>}
      <header className="bm-header">
        <div className="bm-brand"><span className="bm-brand-icon"><LogoMark className="bm-brand-mark" /></span><strong>BEATMAKER CUES</strong></div>
        <input aria-label="Session name" className="bm-session" value={name} onChange={e => setName(e.target.value)} maxLength={100} />
        <label className="bm-volume"><SpeakerHigh size={18} /><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={p.muted ? 0 : p.volume} onChange={e => p.setVolume(Number(e.target.value))} /><span>{Math.round((p.muted ? 0 : p.volume) * 100)}%</span></label>
        <div className="bm-header-actions">
          <button onClick={onDiscover}><MagnifyingGlass size={17} /> Discover</button>
          <button className="bm-icon-button" onClick={openSettings} aria-label="Settings"><GearSix size={19} /></button>
          <button onClick={() => setGuide(true)}><Info size={17} /> Guide</button>
          <button onClick={() => file.current?.click()}><FolderOpen size={17} /> Load</button>
          <button onClick={() => void saveSession()}><DownloadSimple size={17} /> Save</button>
          <button className="bm-primary" disabled={!engineReady} onClick={() => engineAction("advanced")}><SlidersHorizontal size={18} /> ADVANCED</button>
        </div>
        <input ref={file} type="file" accept=".json" hidden onChange={e => { void importSession(e.target.files?.[0]); e.target.value = ""; }} />
      </header>

      <div className="bm-workspace">
        <aside className="bm-library">
          <div className="bm-library-heading"><button className="bm-tab is-active" onClick={() => selectCollection("all")}>LIBRARY <span>({tracks.length})</span></button><button className={`bm-tab ${!list ? "is-selected" : ""}`} onClick={() => setList(false)} aria-label="Cover view"><GridFour size={15} /> COVERS</button><button className={`bm-tab ${list ? "is-selected" : ""}`} onClick={() => setList(true)}><List size={16} /> LIST</button></div>
          <div className="bm-collections" aria-label="Studio playlists">{library.playlists.map(playlist => <div className={`bm-collection ${source === playlist.id ? "is-selected" : ""}`} key={playlist.id}>
            <button type="button" className="bm-collection-open" aria-label={`Open playlist ${playlist.name}`} onClick={() => selectCollection(playlist.id)}><PlaylistIcon size={17} /><span>{playlist.name}</span><small>{playlist.tracks.length}</small></button>
            <button type="button" className="bm-collection-delete" aria-label={`Delete playlist ${playlist.name}`} title="Delete playlist" onClick={() => void deleteCollection(playlist.id)}><TrashIcon size={14} /></button>
          </div>)}</div>
          <form className="bm-search-row" onSubmit={e => { e.preventDefault(); void search(); }}>
            <select className="bm-search-type" aria-label="Studio search type" value={searchType} onChange={e => { controller.current?.abort(); setSearching(false); setResults(null); setSearchType(e.target.value); setPlaylistQuery(""); }}><option value="songs">Songs</option><option value="playlists">Playlists</option></select>
            <div className="bm-search"><MagnifyingGlass size={18} /><input ref={input} value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value) { controller.current?.abort(); setSearching(false); setResults(null); setPlaylistQuery(""); } }} placeholder="Search music or paste a YouTube link…" aria-label="Search music" /><button type="button" aria-label="Clear search" onClick={() => { controller.current?.abort(); setSearching(false); setQuery(""); setResults(null); setPlaylistQuery(""); }}><X size={13} /></button></div>
            <button className="bm-icon-button" type="submit" aria-label="Search YouTube Music"><Plus size={21} /></button>
          </form>
          <div className="bm-library-filter">
            <select aria-label="Library collection" value={source} onChange={e => selectCollection(e.target.value)}><option value="all">All tracks</option><option value="favorites">Favorites</option><option value="history">Recently played</option>{library.playlists.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <button type="button" className="bm-new-playlist" onClick={() => setCreatingPlaylist(true)} aria-label="New playlist" title="New playlist"><Plus size={14} /> Playlist</button>
            <span>{searching ? "SEARCHING…" : results ? `${results.length} RESULTS` : "YOUR COLLECTION"}</span>
          </div>
          {searchType === "playlists" ? <div className="bm-playlist-search"><YouTubePlaylists query={playlistQuery} onPreview={launch} onImported={playlist => selectCollection(playlist.id)} /></div> : <div className={`bm-covers ${list ? "bm-list" : ""}`} aria-busy={searching}>
            {shown.map(t => <div className={`bm-track ${track?.id === t.id ? "is-current" : ""}`} key={t.id}>
              <button className="bm-track-main" onClick={() => launch(t)} aria-label={`Play ${t.title}`}>
                <div className="bm-cover-art">{t.art || t.thumb ? <img src={t.art || t.thumb} loading="lazy" alt="" /> : <MusicNotes size={30} />}<span className="bm-cover-play"><Play weight="fill" size={21} /></span></div>
                <div className="bm-track-info"><strong title={t.title}>{t.title}</strong><span>{t.artist || "Unknown artist"}</span></div>
              </button>
              <button className={`bm-favorite ${library.isFavorite(t.id) ? "is-saved" : ""}`} aria-label={library.isFavorite(t.id) ? "Remove from favorites" : "Save to favorites"} onClick={() => void library.toggleFavorite(t)}>{library.isFavorite(t.id) ? "♥" : "+"}</button>
              <button className="bm-track-playlist" aria-label={`Add ${t.title} to a playlist`} title="Add to playlist" onClick={() => openAddToPlaylist([t])}><PlaylistIcon size={15} /></button>
              {!results && <button className="bm-track-remove" aria-label={`Remove ${t.title} from ${selectedPlaylist ? selectedPlaylist.name : source === "favorites" ? "favorites" : source === "history" ? "history" : "library"}`} title={selectedPlaylist ? "Remove from this playlist" : source === "all" ? "Remove from library and all playlists" : "Remove from collection"} onClick={() => void removeTrack(t)}><TrashIcon size={14} /></button>}
            </div>)}
            {!shown.length && <div className="bm-empty-library"><span className="bm-empty-symbol"><MusicNotes size={34} weight="thin" /></span><h2>{library.status === "error" ? "Library unavailable" : results ? "No tracks found" : "Your next idea starts here."}</h2><p>{library.status === "error" ? "Check the local server, then retry." : "Search YouTube Music above, choose a track, and make it your own."}</p>{library.status === "error" ? <button onClick={() => void library.load()}>Retry library</button> : <div className="bm-suggestions">{["J Dilla", "Nujabes", "Jazz samples"].map(q => <button key={q} onClick={() => { setQuery(q); void search(q); }}>{q} ↗</button>)}</div>}</div>}
          </div>}
          <button className="bm-browser-link" onClick={onBrowse}>Open full music library <ArrowSquareOut size={14} /></button>
        </aside>

        <main className="bm-deck">
          <nav className="bm-banks" aria-label="Cue banks">{BANKS.map(b => <button key={b} className={bank === b ? "is-active" : ""} aria-pressed={bank === b} onClick={() => { setBank(b); setEngineBank(b); setActive(null); }}>{b}</button>)}<button className="bm-map" disabled={!engineReady} onClick={() => engineAction("mapping")} title="Open MIDI mappings"><GridFour size={17} /> MAP</button></nav>
          <section className="bm-pad-shell">
            <div className="bm-section-label"><span>BANK {bank}</span><button disabled={!mediaReady || !engineReady} onPointerDown={e => { if (e.button === 0) { e.preventDefault(); markNext(); } }} onClick={e => { if (e.detail === 0) markNext(); }}>MARK</button><span>{padCount} PADS</span></div>
            <div className="bm-pads" style={{ "--bm-pad-rows": padCount / 4 } as CSSProperties}>{Array.from({ length: padCount }, (_, i) => {
              const key = cueKey(i), cue = cues[key];
              const assigned = track && cue !== undefined;
              const padId = `${bank}:${i + 1}`;
              const padState = feedback.pressed.has(padId) ? "pressed" : feedback.flashing.has(padId) ? "triggered" : feedback.active === padId ? "active" : "idle";
              return <div key={key} data-pad-state={padState} className={`bm-pad ${assigned ? "is-assigned" : ""} ${padState === "triggered" || padState === "pressed" ? "is-triggered" : ""} ${padState === "active" ? "is-active" : ""}`}>
                <button className="bm-pad-hit" disabled={!!track && (!engineReady || !mediaReady)} onClick={e => { if (e.detail === 0) trigger(key, e.shiftKey); }} onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); padFeedback({ bank, pad: i + 1, phase: "pressed" }); trigger(key, e.shiftKey); }} onPointerUp={() => padFeedback({ bank, pad: i + 1, phase: "released" })} onPointerCancel={() => padFeedback({ bank, pad: i + 1, phase: "released" })} onPointerLeave={() => padFeedback({ bank, pad: i + 1, phase: "released" })} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); trigger(key, e.shiftKey); } }} aria-label={`${assigned ? "Trigger" : "Set"} cue ${i + 1}${assigned ? ` at ${time(cue)}` : ""}`}>
                  <span className="bm-pad-number">{i + 1}</span>
                  {assigned ? <><img className="bm-pad-art" src={track.art || track.thumb} alt="" style={{ objectPosition: `${30 + i % 4 * 15}% center` }} /><div className="bm-pad-shade" /><div className="bm-pad-info"><strong>{track.title}</strong><span>CUE {String(i + 1).padStart(2, "0")} <b>•</b> {time(cue)} <b>•</b> {cue.toFixed(2)}s</span></div></> : <span className="bm-pad-empty"><Plus size={22} weight="thin" /><strong>EMPTY</strong><span>{track ? "Click to mark cue" : "Select a track"}</span></span>}
                </button>
                {assigned && <button className="bm-pad-clear" onClick={() => { window.musikeBeatmakerEngine?.remove(key); if (active === key) setActive(null); }} aria-label={`Clear cue ${i + 1}`} title="Clear cue"><X size={13} /></button>}
              </div>;
            })}</div>
          </section>
          <div id="bm-timeline" className="bm-cue-timeline ytp-progress-bar" aria-label="Cue timeline" />
          <section className="bm-transport">
            <div className="bm-now-art" ref={video}>{p.mediaKind !== "video" && (track ? <img src={track.art || track.thumb} alt="" /> : <MusicNotes size={23} />)}</div>
            <div className="bm-now"><strong>{track?.title || "No track selected"}</strong><span>{status || track?.artist || "Choose a track"}</span></div>
            <button className="bm-video-toggle" disabled={!track} aria-label="Toggle music video" aria-pressed={p.preferVideo} onClick={() => p.setPreferVideo(!p.preferVideo)}>{p.preferVideo ? "VIDEO" : "AUDIO"}</button>
            <button className="bm-icon-button" aria-label="Return to start" disabled={!track} onClick={() => p.seek(0)}><ArrowCounterClockwise size={18} /></button>
            <button className="bm-play" aria-busy={p.status === "loading"} aria-label={p.status === "playing" || p.status === "loading" ? "Pause" : "Play"} disabled={!track} onClick={p.toggle}>{p.status === "loading" ? <CircleNotch className="animate-spin" size={19} /> : p.status === "playing" ? <Pause weight="fill" size={19} /> : <Play weight="fill" size={19} />}</button>
            <span className="bm-time">{time(p.position)}</span><input className="bm-seek" type="range" aria-label="Playback position" min="0" max={p.duration || 1} step="0.01" value={Math.min(p.position, p.duration || 1)} disabled={!track} onChange={e => p.seek(Number(e.target.value))} /><span className="bm-time">{time(p.duration)}</span>
          </section>
          <div className="bm-tools">
            <label>MIDI <select aria-label="MIDI controller preset" value={midiPreset} onChange={e => { saveControllerPreset(e.target.value); setMidiPreset(e.target.value); }}>
              {CONTROLLER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select></label>
            <label><input type="checkbox" checked={midiOverwrite} onChange={e => setMidiOverwrite(e.target.checked)} /> MIDI overwrite</label>
            <div className="bm-tool-label">PERFORMANCE</div>
            <button disabled={!engineReady} onClick={() => engineAction("mini")}>CUES / LOOP</button>
            <button disabled={!engineReady} onClick={() => engineAction("sequencer")}>SEQUENCER</button>
            <button disabled={!engineReady} onClick={() => engineAction("fx")}>FX PAD</button>
            <button disabled={!engineReady} onClick={() => engineAction("sidechain")}>SIDECHAIN</button>
            <button disabled={!engineReady || p.mediaKind !== "video" || !mediaReady} title={p.mediaKind !== "video" ? "Switch to Video mode to use VJ" : "Open the video compositor"} onClick={() => engineAction("vj")}>VJ</button>
            <button disabled={!mediaReady || !engineReady} onClick={() => engineAction("random")} aria-label="Randomize cues"><Shuffle size={17} /></button>
            <label className="bm-pitch">{rateLabel}
              <input type="range" min={rateLimits[0]} max={rateLimits[1]} value={pitch} disabled={!engineReady || !mediaReady} aria-label="Pitch percentage"
                onChange={e => { const value = Number(e.target.value); setPitch(value); window.musikeBeatmakerEngine?.pitch(value); }}
                onDoubleClick={() => { setPitch(0); window.musikeBeatmakerEngine?.pitch(0); }} />
              <span>{pitch > 0 ? "+" : ""}{Math.round(pitch)}%</span>
            </label>
          </div>
        </main>
      </div>
      {guide && <div className="bm-modal-backdrop" onClick={() => setGuide(false)}><section className="bm-guide" role="dialog" aria-modal="true" aria-label="Beatmaker guide" onClick={e => e.stopPropagation()}><button className="bm-guide-close" aria-label="Close guide" autoFocus onClick={() => setGuide(false)}><X size={20} /></button><span className="bm-eyebrow">GUIDE</span><h2>Studio basics</h2><p>Choose a track, then use its cue pads to jump to a moment. Loops, effects and MIDI are available from the toolbars.</p><dl><dt>1–9 / 0</dt><dd>Trigger the first ten cues</dd><dt>Click an empty pad</dt><dd>Mark the current playback position</dd><dt>Shift + click</dt><dd>Replace a cue with the current position</dd><dt>I / O</dt><dd>Set region loop IN / OUT</dd><dt>Space</dt><dd>Play / pause</dd><dt>A–J bank buttons</dt><dd>Switch cue banks for this track</dd><dt>CUES / LOOP</dt><dd>Open or hide the compact performance bar</dd><dt>MAP</dt><dd>Open MIDI mappings</dd><dt>Advanced</dt><dd>Original MIDI, stems, routing, loopers and effects controls</dd><dt>Settings</dt><dd>Catalog language, yt-dlp and library backup</dd><dt>Save / Load</dt><dd>Export or restore a session with its cue banks</dd></dl><button className="bm-primary" onClick={() => setGuide(false)}>Close</button></section></div>}
      <NamePlaylistDialog
        open={creatingPlaylist}
        title="New playlist"
        action="Create"
        onClose={() => setCreatingPlaylist(false)}
        onSubmit={async (next) => {
          const playlist = await library.createPlaylist(next);
          setCreatingPlaylist(false);
          if (playlist) {
            selectCollection(playlist.id);
          }
        }}
      />
      <AddToPlaylistDialog />
      <SettingsDialog studio /><Toasts />
    </div>
  );
}
