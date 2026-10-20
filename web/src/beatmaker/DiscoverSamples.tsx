import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, DownloadSimple, GearSix, Heart, MagnifyingGlass, MusicNotes, Pause, Play, Plus, Repeat, RepeatOnce, Shuffle, SkipBack, SkipForward, SpeakerHigh, SpeakerX, Waveform, X } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { desktop } from "../lib/desktop";
import { formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import { selectCurrent, usePlayer, useStatusText } from "../player/player";
import { useLibrary } from "../stores/library";
import { openSettings } from "../stores/system";
import { toast } from "../stores/ui";
import { LogoMark } from "../components/Brand";
import { SettingsDialog } from "../components/SettingsDialog";
import { Slider } from "../components/Slider";
import { Toasts } from "../components/Toasts";
import "./beatmaker.css";
import "./discover.css";

const CRATES = [
  { title: "Soul & dust", query: "70s soul instrumental", label: "WARM / TEXTURED", color: "#5d4939" },
  { title: "Jazz cuts", query: "jazz instrumental", label: "KEYS / BRASS / GROOVE", color: "#3c4c4b" },
  { title: "Drum breaks", query: "drum breaks", label: "RHYTHM / RAW DRUMS", color: "#4a424f" },
  { title: "Ambient spaces", query: "ambient instrumental", label: "ATMOSPHERE / SLOW", color: "#394553" },
  { title: "Rare grooves", query: "rare groove instrumental", label: "DEEP / OFF THE GRID", color: "#4e4d35" },
  { title: "Global sounds", query: "world jazz instrumental", label: "PERCUSSION / MELODY", color: "#573a3b" },
];
const PACKS = [
  { id: "kick", title: "Kick collection", label: "LOW END / 10 WAV HITS" },
  { id: "snare", title: "Snare collection", label: "SNAP & TEXTURE / 10 WAV HITS" },
  { id: "hihat", title: "Hi-hat collection", label: "TOP END / 10 WAV HITS" },
] as const;
type Mode = "tracks" | typeof PACKS[number]["id"];
const duration = (s: number) => `${Math.floor((s || 0) / 60)}:${Math.floor((s || 0) % 60).toString().padStart(2, "0")}`;

function DiscoverPlayer({ sample, onStopSample, onOpenStudio, onMarkCues }: { sample: string | null; onStopSample(): void; onOpenStudio(): void; onMarkCues(track: Track): void }) {
  const current = usePlayer(selectCurrent);
  const status = usePlayer((s) => s.status);
  const statusText = useStatusText();
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const buffered = usePlayer((s) => s.buffered);
  const hasQueue = usePlayer((s) => s.queue.length > 0);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const seek = usePlayer((s) => s.seek);
  const toggle = usePlayer((s) => s.toggle);
  const prev = usePlayer((s) => s.prev);
  const next = usePlayer((s) => s.next);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const cycleRepeat = usePlayer((s) => s.cycleRepeat);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const isFavorite = useLibrary((s) => !!current && s.isFavorite(current.id));
  const toggleFavorite = useLibrary((s) => s.toggleFavorite);
  const level = muted ? 0 : volume;
  const RepeatIcon = repeat === "one" ? RepeatOnce : Repeat;
  const playing = status === "playing" || status === "loading";
  const title = sample ? `Previewing ${sample.split("/").at(-1)}` : current?.title || "Pick a track or audition a sample";
  const subtitle = sample ? "Included sample bank · WAV" : statusText || current?.artist || "Your next session starts with a sound.";
  return <footer className="ds-player" aria-label="Global player">
    <div className="ds-player-track">
      <button className="ds-player-art" onClick={onOpenStudio} aria-label="Open the studio from the player">
        {sample ? <Waveform size={22} /> : current?.art || current?.thumb ? <img src={current.art || current.thumb} alt="" /> : <MusicNotes size={21} />}
      </button>
      <div className="ds-player-meta"><strong title={title}>{title}</strong><span title={subtitle}>{subtitle}</span></div>
      {sample ? <button className="ds-player-stop" onClick={onStopSample} aria-label="Stop sample preview">STOP</button> : current ? <><button className="ds-player-cues" onClick={() => onMarkCues(current)} aria-label={`Open the studio to mark cues for ${current.title}`} title="Open the studio to mark cues"><Plus size={13} weight="bold" /> MARK CUES</button><button className={`ds-player-fav ${isFavorite ? "is-saved" : ""}`} onClick={() => void toggleFavorite(current)} aria-label={isFavorite ? `Remove ${current.title} from favorites` : `Add ${current.title} to favorites`}><Heart size={17} weight={isFavorite ? "fill" : "regular"} /></button></> : null}
    </div>
    <div className="ds-player-center">
      <div className="ds-player-transport">
        <button aria-label="Shuffle discovery queue" className={shuffle ? "is-active" : ""} disabled={!hasQueue || !!sample} onClick={toggleShuffle}><Shuffle size={16} /></button>
        <button aria-label="Previous track" disabled={!hasQueue || !!sample} onClick={prev}><SkipBack size={18} weight="fill" /></button>
        <button className="ds-player-play" aria-label={sample ? "Pause sample preview" : playing ? "Pause" : "Play"} disabled={!sample && !hasQueue} onClick={sample ? onStopSample : toggle}>{sample || playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}</button>
        <button aria-label="Next track" disabled={!hasQueue || !!sample} onClick={next}><SkipForward size={18} weight="fill" /></button>
        <button aria-label="Repeat discovery queue" className={repeat !== "off" ? "is-active" : ""} disabled={!hasQueue || !!sample} onClick={cycleRepeat}><RepeatIcon size={16} /></button>
      </div>
      <div className="ds-player-progress">
        <span>{formatTime(position)}</span>
        <Slider label="Playback position" value={position} max={duration} buffered={buffered} onChange={seek} step={5} valueText={formatTime} className="ds-player-scrubber" />
        <span>{formatTime(duration)}</span>
      </div>
    </div>
    <div className="ds-player-side">
      <div className="ds-player-volume">
        <button aria-label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>{level === 0 ? <SpeakerX size={18} /> : <SpeakerHigh size={18} />}</button>
        <Slider label="Discovery volume" value={level} max={1} step={0.05} live onChange={setVolume} valueText={(v) => `${Math.round(v * 100)}%`} className="ds-player-volume-slider" />
        <span>{Math.round(level * 100)}%</span>
      </div>
      <span className="ds-player-hint">DISCOVER → CUE → CREATE</span>
    </div>
  </footer>;
}

export function DiscoverSamples({ onStudio, onBrowse }: { onStudio(track?: Track): void; onBrowse(): void }) {
  const library = useLibrary();
  const player = usePlayer();
  const current = usePlayer(selectCurrent);
  const [mode, setMode] = useState<Mode>("tracks");
  const [query, setQuery] = useState("");
  const [heading, setHeading] = useState("Jazz cuts");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastQuery, setLastQuery] = useState("jazz instrumental");
  const [playingSample, setPlayingSample] = useState<string | null>(null);
  const sample = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (window.musikeBeatmakerHost) window.musikeBeatmakerHost.active = false;
    void library.load();
    const audio = sample.current = new Audio();
    audio.onended = () => setPlayingSample(null);
    audio.onerror = () => { setPlayingSample(null); toast("This sample could not be loaded. Try another hit.", "error"); };
    void search("jazz instrumental", "Jazz cuts");
    return () => { request.current?.abort(); audio.pause(); audio.removeAttribute("src"); audio.load(); audio.onended = audio.onerror = null; };
  }, []);

  useEffect(() => { if (sample.current) sample.current.volume = player.muted ? 0 : player.volume; }, [player.volume, player.muted]);

  async function search(value: string, title = value) {
    if (!value.trim()) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setMode("tracks"); setHeading(title); setLastQuery(value); setBusy(true); setError(""); setTracks([]);
    try {
      const found = await api.search(value.trim(), "song", controller.signal);
      if (!controller.signal.aborted) setTracks(found);
    } catch (err) { if (!controller.signal.aborted) setError((err as Error).message || "Music discovery is unavailable right now."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  function previewTrack(track: Track) {
    sample.current?.pause(); setPlayingSample(null);
    if (current?.id === track.id) player.toggle();
    else { player.setAutoRadio(false); player.playList([track]); }
  }

  function openStudio(track?: Track) {
    sample.current?.pause(); setPlayingSample(null);
    onStudio(track);
  }

  function openPack(id: Mode, title: string) {
    request.current?.abort(); setBusy(false); setError(""); setMode(id); setHeading(title);
  }

  async function previewSample(path: string) {
    const audio = sample.current;
    if (!audio) return;
    if (playingSample === path && !audio.paused) { audio.pause(); setPlayingSample(null); return; }
    if (player.status === "playing" || player.status === "loading") player.toggle();
    audio.pause(); audio.src = path; audio.volume = player.muted ? 0 : player.volume;
    setPlayingSample(path);
    try { await audio.play(); } catch (err) { setPlayingSample(null); if ((err as Error).name !== "AbortError") toast((err as Error).message, "error"); }
  }

  return <div className="bm-app ds-app">
    {desktop && <div className="bm-titlebar app-drag"><span>YT BEATMAKER CUES DESKTOP</span><span>v{__APP_VERSION__} · POWERED BY MUSIKE</span></div>}
    <header className="bm-header ds-header">
      <div className="bm-brand"><span className="bm-brand-icon"><LogoMark className="bm-brand-mark" /></span><strong>BEATMAKER CUES</strong></div>
      <span className="ds-header-caption">YOUR NEXT IDEA IS IN HERE.</span>
      <div className="ds-navigation"><span className="ds-current-page">DISCOVER</span><button onClick={() => openStudio()}>STUDIO <ArrowRight size={16} /></button><button onClick={onBrowse}>MUSIC LIBRARY</button><button className="bm-icon-button" aria-label="Settings" onClick={openSettings}><GearSix size={19} /></button></div>
    </header>
    <main className="ds-scroll">
      <section className="ds-hero">
        <div><span className="bm-eyebrow">01 / DISCOVER SAMPLES</span><h1>Find a sound.<br /><span>Make it yours.</span></h1><p>Dig through music, audition a drum hit, and bring your next idea into the studio.</p></div>
        <form className="ds-search-form" onSubmit={e => { e.preventDefault(); void search(query); }}>
          <label className="bm-search"><MagnifyingGlass size={21} /><input aria-label="Discover samples search" placeholder="Search artists, sounds, or paste a YouTube link…" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" aria-label="Clear discovery search" onClick={() => setQuery("")}><X size={14} /></button></label>
          <button className="bm-primary" type="submit" disabled={!query.trim()}>START DIGGING <ArrowRight size={17} /></button>
          <span className="ds-search-note">LIVE MUSIC DISCOVERY + 30 INCLUDED DRUM SAMPLES</span>
        </form>
      </section>
      <section className="ds-crates" aria-label="Music discovery categories">{CRATES.map(crate => <button key={crate.title} className={`ds-crate ${heading === crate.title && mode === "tracks" ? "is-selected" : ""}`} onClick={() => void search(crate.query, crate.title)} style={{ "--crate-color": crate.color } as CSSProperties}><span className="ds-crate-texture"><MusicNotes size={28} weight="thin" /></span><strong>{crate.title}</strong><span>{crate.label}</span><ArrowRight className="ds-crate-arrow" size={16} /></button>)}</section>
      <div className="ds-content">
        <section className="ds-results">
          <div className="ds-section-heading"><div><span className="bm-eyebrow">{mode === "tracks" ? "MUSIC TO EXPLORE" : "BUNDLED / AVAILABLE OFFLINE"}</span><h2>{heading}</h2></div><button aria-label="Discover a random music category" onClick={() => { const crate = CRATES[Math.floor(Math.random() * CRATES.length)]; void search(crate.query, crate.title); }}><Shuffle size={16} /> SURPRISE ME</button></div>
          {mode === "tracks" ? <>
            {busy && <div className="ds-state" role="status"><span className="ds-loading" /><strong>Digging through the catalog…</strong><span>Fetching real music results.</span></div>}
            {!busy && error && <div className="ds-state" role="alert"><MusicNotes size={30} /><strong>Couldn’t load music discovery</strong><p>{error}</p><button onClick={() => void search(lastQuery, heading)}>Retry search</button><span>The included drum collections are still available.</span></div>}
            {!busy && !error && !tracks.length && <div className="ds-state"><MusicNotes size={30} /><strong>No matches this time.</strong><p>Try another artist, sound or discovery category.</p></div>}
            <div className="ds-track-grid">{tracks.map(track => {
              const active = current?.id === track.id && (player.status === "playing" || player.status === "loading");
              return <article className={`ds-track-card ${active ? "is-previewing" : ""}`} key={track.id}>
                <button className="ds-art" aria-label={`${active ? "Pause" : "Preview"} ${track.title}`} onClick={() => previewTrack(track)}>{track.art || track.thumb ? <img src={track.art || track.thumb} alt="" loading="lazy" /> : <MusicNotes size={35} />}<span className="ds-art-play">{active ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}</span><span className="ds-duration">{duration(track.duration)}</span></button>
                <div className="ds-card-meta"><strong title={track.title}>{track.title}</strong><span>{track.artist}</span></div>
                <div className="ds-card-actions"><button onClick={() => openStudio(track)} aria-label={`Load ${track.title} into studio`}>LOAD IN STUDIO <ArrowRight size={13} /></button><button className={library.isFavorite(track.id) ? "is-saved" : ""} aria-label={`${library.isFavorite(track.id) ? "Unsave" : "Save"} ${track.title}`} onClick={() => void library.toggleFavorite(track)}><Heart size={17} weight={library.isFavorite(track.id) ? "fill" : "regular"} /></button></div>
              </article>;
            })}</div>
          </> : <div className="ds-sample-grid">{Array.from({ length: 10 }, (_, index) => {
            const path = `/beatmaker/sounds/${mode}${index + 1}.wav`;
            const playing = playingSample === path;
            return <article className={`ds-sample ${playing ? "is-previewing" : ""}`} key={path}>
              <button className="ds-sample-play" aria-label={`${playing ? "Stop" : "Preview"} ${mode} ${index + 1}`} onClick={() => void previewSample(path)}>{playing ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}</button>
              <div><strong>{mode === "hihat" ? "Hi-hat" : mode === "kick" ? "Kick" : "Snare"} {String(index + 1).padStart(2, "0")}</strong><span>INCLUDED SAMPLE · WAV</span></div>
              <Waveform className="ds-wave" size={45} weight="thin" />
              <a href={path} download={`${mode}${index + 1}.wav`} aria-label={`Download ${mode} ${index + 1} WAV`} title="Download WAV"><DownloadSimple size={20} /></a>
            </article>;
          })}</div>}
        </section>
        <aside className="ds-sidebar"><span className="bm-eyebrow">THE INCLUDED COLLECTION</span><h2>Small hits.<br />Big possibilities.</h2><p>30 built-in drum samples. Preview or download the WAV files, then find them in the studio’s Built-in sample pack.</p><div className="ds-packs">{PACKS.map(pack => <button className={mode === pack.id ? "is-selected" : ""} key={pack.id} onClick={() => openPack(pack.id, pack.title)}><span className="ds-pack-icon"><Waveform size={22} /></span><span><strong>{pack.title}</strong><small>{pack.label}</small></span><ArrowRight size={16} /></button>)}</div><button className="ds-open-studio bm-primary" onClick={() => openStudio()}>OPEN THE STUDIO <ArrowRight size={16} /></button><span className="ds-sidebar-note">Music discovery streams from YouTube. Included WAV hits are bundled with the app.</span></aside>
      </div>
    </main>
    <DiscoverPlayer sample={playingSample} onStopSample={() => { sample.current?.pause(); setPlayingSample(null); }} onOpenStudio={() => openStudio()} onMarkCues={openStudio} />
    <SettingsDialog studio /><Toasts />
  </div>;
}
