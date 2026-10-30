import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowsClockwiseIcon, QueueIcon, MusicNotesIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { Scrubber, Transport } from "../components/Controls";
import { Modal } from "../components/Modal";
import { CueWaveform } from "../components/CueWaveform";
import { TrackList } from "../components/TrackList";
import { Artwork } from "../components/Artwork";
import { PageHeader } from "../components/Page";
import { formatTime } from "../lib/format";
import { cn } from "../lib/format";
import { useT } from "../i18n";
import { cuePosition, independentTuningAvailable, selectCurrent, usePlayer } from "../player/player";
import { CUE_BANKS, useCueStore } from "../mobile/cueStore";
import { midi, midiAvailable, type MidiDevice, type MidiMessage } from "../native/midi";
import { CONTROLLER_PRESETS, mapControllerMessage, readControllerPreset, saveControllerPreset } from "../native/controllerMapping";
import { padFeedback, usePadFeedback } from "../mobile/padFeedback";
import { playerShortcutsEnabled } from "../native/host";
import { changePadSample, hasPadSample, padSamplesAvailable, playPadSample, refreshPadSamples, usePadSamples, type PadSample } from "../mobile/padSamples";
import { toast } from "../stores/ui";

const formatSemitones = (st: number) => `${st > 0 ? "+" : ""}${st} st`;

function CueSongs() {
  const queue = usePlayer(s=>s.queue);
  return <div className="cue-song-browser min-w-0 flex-1">
    <span className="cue-song-caption text-[10px] text-fg-3">Playlist songs · {queue.length}</span>
    <div role="region" aria-label="Playlist songs" className="cue-song-list scroll-area w-full overflow-y-auto rounded-lg text-fg"><TrackList tracks={queue} header={false} showAlbum={false} onSelect={index=>usePlayer.getState().jumpTo(index)}/></div>
  </div>;
}

export default function Cues() {
  const t = useT();
  const track = usePlayer(selectCurrent);
  const loop = usePlayer((s) => s.loop);
  const speed = usePlayer((s) => Math.round(s.speed));
  const speedMode = usePlayer((s) => s.speedMode);
  const tuning = usePlayer((s) => s.tuning);
  const cues = useCueStore((s) => s.cues);
  const bank = useCueStore((s) => s.bank);
  const samples = usePadSamples(s => s.samples);
  const sampleSupport = padSamplesAvailable();
  const [sampleEdit, setSampleEdit] = useState(false);
  const [samplePad, setSamplePad] = useState<{bank:string;pad:number}|null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const nextSlot = useCueStore.getState().nextSlot();
  const nextPad = nextSlot?.pad;
  const [mapping, setMapping] = useState(readControllerPreset);
  const [heldPads, setHeldPads] = useState<Record<string, number>>({});
  const feedback = usePadFeedback();
  const [overwrite, setOverwrite] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  const [queuePreference,setQueuePreference]=useState<boolean|null>(null);
  const [wide,setWide]=useState(()=>window.innerWidth>=768);
  const [short,setShort]=useState(()=>window.innerHeight<=360);
  const queueOpen=queuePreference??wide;
  useEffect(()=>{const update=()=>{setWide(window.innerWidth>=768);setShort(window.innerHeight<=360);};window.addEventListener('resize',update);return()=>window.removeEventListener('resize',update);},[]);
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  /** What the finger on a pad is doing: a long press marks the cue instead of playing it. */
  const press = useRef({ timer: null as number | null, marked: false, played: false });
  const faderTap = useRef({ started: 0, startX: 0, startY: 0, previous: 0, previousX: 0, previousY: 0 });

  useEffect(() => {
    useCueStore.getState().setTrack(track?.id ?? null);
  }, [track?.id]);

  useEffect(() => {
    const refresh = () => { void refreshPadSamples().catch(error => toast(error.message, 'error')); };
    const update = (event: Event) => usePadSamples.getState().update((event as CustomEvent<PadSample[]>).detail);
    refresh();window.addEventListener('plugin-pad-samples',update);window.addEventListener('pageshow',refresh);document.addEventListener('visibilitychange',refresh);
    return () => {window.removeEventListener('plugin-pad-samples',update);window.removeEventListener('pageshow',refresh);document.removeEventListener('visibilitychange',refresh);};
  }, []);

  const trigger = useCallback((pad: number) => {
    const bank=useCueStore.getState().bank;
    if(hasPadSample(bank,pad)){void playPadSample(bank,pad).catch(error=>toast(error.message,'error'));return;}
    const time = useCueStore.getState().cues[pad];
    if (time == null) return;
    usePlayer.getState().cue(time, { bank: useCueStore.getState().bank, pad });
  }, []);

  const mark = useCallback((pad: number | null, at = cuePosition().catch(() => null), alignTransport = true) => {
    const player = usePlayer.getState();
    if (!player.queue[player.index]) return;
    const { trackId, bank } = useCueStore.getState();
    void at.then((position) => {
      const store = useCueStore.getState();
      if (store.trackId !== trackId || store.bank !== bank || position == null || !Number.isFinite(position)) return;
      if(alignTransport)usePlayer.setState({position});
      if (pad == null) store.setNextCue(position);
      else store.setCue(pad, position);
    }).catch(() => {});
  }, []);

  useEffect(()=>{
    if(!playerShortcutsEnabled())return;
    const onKey=(event:KeyboardEvent)=>{
      const target=event.target;
      if(event.repeat||event.altKey||target instanceof HTMLElement&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)||!!target.closest('[role="dialog"]'))||document.querySelector('[role="dialog"]'))return;
      const digit=/^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1]??(/^[0-9]$/.test(event.key)?event.key:null);
      if(digit===null)return;
      const number=Number(digit),pad=event.shiftKey&&number>=1&&number<=6?number+10:number===0?10:number;
      if(pad>mapping.padToNote.length||(!usePlayer.getState().queue.length&&!hasPadSample(useCueStore.getState().bank,pad)))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(hasPadSample(useCueStore.getState().bank,pad))trigger(pad);
      else if(event.metaKey||event.ctrlKey||overwrite||useCueStore.getState().cues[pad]==null)mark(pad);
      else{padFeedback({bank:useCueStore.getState().bank,pad,phase:'triggered'});trigger(pad);}
    };
    window.addEventListener('keydown',onKey,true);
    return()=>window.removeEventListener('keydown',onKey,true);
  },[mark,trigger,mapping.padToNote.length,overwrite]);

  useEffect(() => {
    if (!midiAvailable) return;
    let disposed = false;
    let handle: { remove: () => Promise<void> } | undefined;
    const onMessage = (message: MidiMessage) => {
      const target = mapControllerMessage(message, mapping, useCueStore.getState().bank);
      if (!target) return;
      padFeedback({ ...target, phase: target.pressed ? "pressed" : "released" });
      const key = `${target.bank}:${target.pad}`;
      setHeldPads(previous => {
        const next = { ...previous };
        if (target.pressed) next[key] = target.velocity;
        else delete next[key];
        return next;
      });
      if (!target.pressed) return;
      const store = useCueStore.getState();
      store.setBank(target.bank);
      if(hasPadSample(target.bank,target.pad)){trigger(target.pad);return;}
      const time = useCueStore.getState().cues[target.pad];
      if (time != null && !overwrite) { trigger(target.pad); return; }
      const trackId = store.trackId;
      void cuePosition().then(position => {
        if (useCueStore.getState().trackId === trackId) {
          useCueStore.getState().setCue(target.pad, position, target.bank);
        }
      }).catch(() => {});
    };
    const connect = async () => {
      const result = await midi.list().catch(() => ({ devices: [] }));
      if (disposed) return;
      setDevices(result.devices);
      handle = await midi.addListener("message", onMessage).catch(() => undefined);
      if (disposed) void handle?.remove();
    };
    void connect();
    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [trigger, mapping, overwrite]);

  const refreshMidi = () => {
    void midi.refresh().then(() => midi.list()).then((result) => setDevices(result.devices)).catch(() => setDevices([]));
  };

  /**
   * Pads play on press, not on release: waiting for the finger to lift adds the whole tap to the delay.
   * Holding a pad still marks (or overwrites) it, and a tap on an empty pad still marks it.
   */
  const playPad = (pad: number) => {
    if (cues[pad] != null && !overwrite) {
      press.current.played = true;
      trigger(pad);
    }
  };

  const down = (pad: number) => {
    padFeedback({ bank: useCueStore.getState().bank, pad, phase: "pressed" });
    press.current.marked = false;
    press.current.played = false;
    if (press.current.timer) window.clearTimeout(press.current.timer);
    if(sampleEdit){press.current.marked=true;setSamplePad({bank,pad});return;}
    if(hasPadSample(bank,pad)){press.current.played=true;trigger(pad);return;}
    if (cues[pad] == null || overwrite) {
      press.current.marked = true;
      mark(pad);
      return;
    }
    // Capture before triggering the saved cue: holding to overwrite must mark where the finger went down,
    // not the old cue plus the long-press delay.
    const at = cuePosition().catch(() => null);
    press.current.timer = window.setTimeout(() => {
      press.current.marked = true;
      mark(pad, at, false);
    }, 600);
    playPad(pad);
  };

  const up = (pad?: number) => {
    if (pad) padFeedback({ bank: useCueStore.getState().bank, pad, phase: "released" });
    if (press.current.timer) window.clearTimeout(press.current.timer);
    press.current.timer = null;
  };

  useEffect(() => () => {
    if (press.current.timer) window.clearTimeout(press.current.timer);
  }, [track?.id, bank]);

  const hit = (pad: number) => {
    const { marked, played } = press.current;
    press.current.marked = false;
    press.current.played = false;
    if (marked || played) return; // already handled while the finger was down
    if(sampleEdit){setSamplePad({bank,pad});return;}
    if (hasPadSample(bank,pad)||cues[pad] != null && !overwrite) trigger(pad);
    else mark(pad);
  };

  return (
    <div className="cue-workspace pb-8">
      <PageHeader alwaysSettings title={t.cues.title} actions={<>
        {short&&<button type="button" className="cue-header-mark hidden rounded-full bg-accent px-2 text-xs font-semibold text-accent-ink" disabled={nextPad==null} aria-label={nextPad==null?t.cues.bankFull:t.cues.markNext(nextPad)} onPointerDown={event=>{if(event.button===0)mark(null);}} onClick={event=>{if(event.detail===0)mark(null);}}>{nextSlot?`${t.cues.mark} ${nextSlot.bank}${nextSlot.pad}`:t.cues.mark}</button>}
        <button type="button" className="cue-queue-toggle inline-flex h-8 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs" aria-label="Toggle playlist" aria-expanded={queueOpen} onClick={()=>setQueuePreference(!queueOpen)}><QueueIcon size={17}/><span className="max-sm:hidden">Playlist</span></button>
        <Link to="/library" className="cue-library-back inline-flex h-8 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs font-medium" aria-label={`${t.common.back}: ${t.nav.library}`}><ArrowLeftIcon size={14}/>{t.nav.library}</Link>
      </>} />

      <div className="cue-body px-4">
        <p className="cue-intro max-w-[46ch] text-sm text-fg-2">{t.cues.subtitle}</p>
        {track || sampleSupport ? (
          <>
            <div className="cue-transport mt-4 flex items-center gap-3 rounded-[16px] bg-surface-2 p-3">
              <Artwork src={track?.thumb} className="cue-artwork size-12 rounded-[10px]" />
              <div className="cue-track-label min-w-0" title={track?`${track.title} · ${track.artist}`:'Sample pads'}><p className="truncate text-sm font-medium">{track?.title??'Sample pads'}</p><p className="truncate text-xs text-fg-2">{track?.artist??'Load samples, or choose a song for cues'}</p></div>
              <button
                type="button"
                disabled={nextPad == null}
                aria-label={nextPad == null ? t.cues.bankFull : t.cues.markNext(nextPad)}
                onPointerDown={(e) => { if (e.button === 0) mark(null); }}
                onClick={(e) => { if (e.detail === 0) mark(null); }}
                className="cue-mark h-9 shrink-0 touch-manipulation rounded-full bg-accent px-3 text-xs font-semibold text-accent-ink active:scale-95 disabled:opacity-40"
              >
                {nextPad == null ? t.cues.bankFull : `${t.cues.mark} ${nextSlot?.bank}${nextPad}`}
              </button>
            </div>

            <CueWaveform padCount={mapping.padToNote.length}/>
            <div className="cue-stage" data-queue-open={queueOpen}>
            {queueOpen&&<aside className="cue-queue-panel"><CueSongs/></aside>}
            <div className="cue-performance">
            <div className="cue-pads-panel">
            <div className="cue-bankbar mt-5 flex items-center gap-2">
              <span className="text-xs font-medium tracking-wide text-fg-3 uppercase">{t.cues.bank}</span>
              <div className="cue-bank-buttons no-scrollbar flex flex-1 gap-1.5 overflow-x-auto">
                {CUE_BANKS.map((letter) => (
                  <button
                    key={letter}
                    type="button"
                    onClick={() => useCueStore.getState().setBank(letter)}
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors",
                      bank === letter ? "bg-accent text-accent-ink" : "bg-surface-2 text-fg-2 active:bg-surface-3",
                    )}
                  >
                    {letter}
                  </button>
                ))}
              </div>
            </div>

            <div className="cue-overwrite-row mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-fg-3">{t.cues.markHint}</p>
              <select aria-label="Cue bank" className="cue-bank-compact hidden rounded-full bg-surface-2 text-xs" value={bank} onChange={event=>{useCueStore.getState().setBank(event.target.value as typeof bank);event.currentTarget.blur();}}>{CUE_BANKS.map(bank=><option key={bank} value={bank}>{bank}</option>)}</select>
              <select aria-label="Pad layout preset" title={mapping.label} value={mapping.id} className="cue-preset rounded-full bg-surface-2 px-2 py-1 text-xs" onChange={event=>{
                const preset=CONTROLLER_PRESETS.find(preset=>preset.id===event.target.value)!;
                saveControllerPreset(preset.id);setMapping(preset);setHeldPads({});event.currentTarget.blur();
              }}>{CONTROLLER_PRESETS.map(preset=><option key={preset.id} value={preset.id}>{preset.id==='legacy12'?'12 pads':preset.id==='sp404mkii-b'?'SP-404 B':'SP-404 A'}</option>)}</select>
              <button type="button" aria-label={`${t.cues.midi} settings`} title={`${t.cues.midi} · ${mapping.label}`} className="cue-midi-settings shrink-0 rounded-full bg-surface-2 px-2 py-1.5 text-[11px] font-medium" onClick={()=>setMidiOpen(true)}>{t.cues.midi}</button>
              {sampleSupport&&<button type="button" aria-label="Manage pad samples" title={sampleEdit?'Finish sample editing':'Load or remove a sample: enable, then tap a pad'} aria-pressed={sampleEdit} className={cn('cue-sample-edit grid size-7 shrink-0 place-items-center rounded-full',sampleEdit?'bg-accent text-accent-ink':'bg-surface-2 text-fg-2')} onClick={()=>setSampleEdit(!sampleEdit)}><MusicNotesIcon size={16}/></button>}
              <button type="button" onClick={()=>useCueStore.getState().clearBank()} className="cue-clear-bank shrink-0 rounded-full bg-surface-2 px-2.5 py-1.5 text-[11px] text-fg-2 active:bg-surface-3">{t.cues.clearBank}</button>
              <button
                type="button"
                aria-pressed={overwrite}
                onClick={() => setOverwrite((on) => !on)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors",
                  overwrite ? "bg-accent text-accent-ink" : "bg-surface-2 text-fg-2",
                )}
              >
                {t.cues.overwrite}
              </button>
            </div>

            <div data-pad-count={mapping.padToNote.length} className={cn("cue-pad-grid mt-3 grid gap-2", mapping.padToNote.length === 12 ? "grid-cols-3" : "grid-cols-4")}>
              {Array.from({ length: mapping.padToNote.length }, (_, i) => i + 1).map((pad) => {
                const time = cues[pad];
                const sample=samples[`${bank}:${pad}`];
                return (
                  <div key={pad} className="relative">
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        down(pad);
                      }}
                      onPointerUp={() => up(pad)}
                      onPointerLeave={() => up(pad)}
                      onPointerCancel={() => up(pad)}
                      data-pad-state={feedback.pressed.has(`${bank}:${pad}`) ? "pressed" : feedback.flashing.has(`${bank}:${pad}`) ? "triggered" : feedback.active === `${bank}:${pad}` ? "active" : "idle"}
                      onContextMenu={(e) => e.preventDefault()}
                      onClick={() => hit(pad)}
                      aria-label={sample?`${t.cues.pad(pad)}: Sample ${sample.name}`:time == null ? `${t.cues.pad(pad)}: ${t.cues.empty}` : `${t.cues.pad(pad)}: ${formatTime(time)}`}
                      title={sample?.error||sample?.name||(sampleEdit?'Load a sample into this pad':undefined)}
                      data-pad-kind={sample?'sample':'cue'}
                      className={cn(
                        "flex aspect-[1.45] w-full touch-none flex-col justify-between rounded-[14px] p-2.5 text-left transition-[transform,background-color] select-none active:scale-[0.97]",
                        time == null && !sample
                          ? "bg-surface-2 ring-1 ring-line active:bg-surface-3"
                          : "bg-accent-soft text-accent-text ring-1 ring-accent/30",
                        heldPads[`${bank}:${pad}`] ? "brightness-150 ring-2 ring-accent" : "",
                        feedback.pressed.has(`${bank}:${pad}`) || feedback.flashing.has(`${bank}:${pad}`) ? "brightness-150 ring-2 ring-accent scale-[0.97]" : "",
                      )}
                    >
                      <span className={cn("text-xs font-semibold", time == null && !sample ? "text-fg-3" : "text-accent-text")}>
                        {pad}{sample?' · SMP':sampleEdit?' · +':''}
                      </span>
                      <span className={cn("block max-w-full truncate font-mono text-[11px]", time == null && !sample ? "text-fg-3" : "text-accent-text")}>
                        {sample?(sample.error?'Missing sample':sample.ready?sample.name:'Loading…'):time == null ? t.cues.empty : formatTime(time)}
                      </span>
                    </button>
                    {time != null && !sample && (
                      <button
                        type="button"
                        aria-label={`${t.cues.pad(pad)}: ${t.common.close}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          useCueStore.getState().clearCue(pad);
                        }}
                        className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-bg/70 text-[13px] leading-none text-fg-2 active:bg-bg"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            </div>
            <div className="cue-controls-panel">
            <section className="cue-speed mt-6 rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{speedMode === "pitch" ? t.cues.pitch : t.cues.speed}</h2>
                <span className="text-right">
                  <span className="block font-mono text-sm text-accent-text">{speed > 0 ? "+" : ""}{speed}%</span>
                </span>
              </div>
              <input
                type="range"
                min={-50}
                max={100}
                step={1}
                value={speed}
                onChange={(e) => usePlayer.getState().setSpeed(Number(e.target.value))}
                onDoubleClick={() => usePlayer.getState().setSpeed(0)}
                onPointerDown={(e) => {
                  const tap = faderTap.current;
                  tap.started = performance.now();
                  tap.startX = e.clientX;
                  tap.startY = e.clientY;
                }}
                onPointerUp={(e) => {
                  if (e.pointerType === "mouse") return;
                  const tap = faderTap.current;
                  const now = performance.now();
                  const moved = Math.hypot(e.clientX - tap.startX, e.clientY - tap.startY);
                  if (moved > 10 || now - tap.started > 250) {
                    tap.previous = 0;
                    return;
                  }
                  if (tap.previous > 0 && now - tap.previous < 300 && Math.hypot(e.clientX - tap.previousX, e.clientY - tap.previousY) < 24) {
                    usePlayer.getState().setSpeed(0);
                    tap.previous = 0;
                  } else {
                    tap.previous = now;
                    tap.previousX = e.clientX;
                    tap.previousY = e.clientY;
                  }
                }}
                onPointerCancel={() => { faderTap.current.previous = 0; }}
                className="mt-3 w-full touch-manipulation accent-[var(--color-accent)]"
                aria-label={speedMode === "pitch" ? t.cues.pitch : t.cues.speed}
              />
              {speedMode === "speed" && independentTuningAvailable && (
                <div className="cue-tuning mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] leading-snug text-fg-3">{t.cues.semitoneNote}</p>
                  <div className="flex shrink-0 gap-1 rounded-full bg-surface-3 p-1">
                    <button
                      type="button"
                      aria-label={t.cues.semitoneDown}
                      disabled={tuning <= -12}
                      onClick={() => usePlayer.getState().setTuning(tuning - 1)}
                      className="h-8 rounded-full px-2.5 text-[11px] font-semibold active:bg-surface-4 disabled:opacity-40"
                    >
                      <span className="cue-label-long">−1 st</span><span className="cue-label-short hidden">−</span>
                    </button>
                    <span className="grid min-w-12 place-items-center font-mono text-[11px] text-accent-text" aria-live="polite">
                      {formatSemitones(tuning)}
                    </span>
                    <button
                      type="button"
                      aria-label={t.cues.semitoneUp}
                      disabled={tuning >= 12}
                      onClick={() => usePlayer.getState().setTuning(tuning + 1)}
                      className="h-8 rounded-full px-2.5 text-[11px] font-semibold active:bg-surface-4 disabled:opacity-40"
                    >
                      <span className="cue-label-long">+1 st</span><span className="cue-label-short hidden">+</span>
                    </button>
                  </div>
                </div>
              )}
              <div className="cue-speed-modes mt-3 flex items-center gap-2">
                <div className="grid flex-1 grid-cols-2 gap-1 rounded-full bg-surface-3 p-1">
                  <button
                    type="button"
                    aria-label={t.cues.pitchMode}
                    onClick={() => usePlayer.getState().setSpeedMode("pitch")}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-semibold transition-colors",
                      speedMode === "pitch" ? "bg-accent text-accent-ink" : "text-fg-2",
                    )}
                  >
                    <span className="cue-label-long">{t.cues.pitchMode}</span><span className="cue-label-short hidden">Pitch</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t.cues.speedMode}
                    onClick={() => usePlayer.getState().setSpeedMode("speed")}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-semibold transition-colors",
                      speedMode === "speed" ? "bg-accent text-accent-ink" : "text-fg-2",
                    )}
                  >
                    <span className="cue-label-long">{t.cues.speedMode}</span><span className="cue-label-short hidden">Speed</span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    usePlayer.getState().setSpeed(0);
                    if (speedMode === "speed") usePlayer.getState().setTuning(0);
                  }}
                  aria-label={t.cues.reset}
                  title={t.cues.reset}
                  className="cue-reset h-10 rounded-full bg-surface-3 px-3 text-xs font-semibold active:scale-95"
                >
                  <ArrowsClockwiseIcon size={14}/><span className="cue-reset-text">{t.cues.reset}</span>
                </button>
              </div>
            </section>

            <section className="cue-loop mt-4 rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold"><span className="cue-label-long">{t.cues.loop}</span><span className="cue-label-short hidden">Loop</span></h2>
                <span className="font-mono text-xs text-fg-2">
                  {loop.from == null ? "—" : formatTime(loop.from)} → {loop.to == null ? "—" : formatTime(loop.to)}
                </span>
              </div>
              <p className="mt-1 text-xs text-fg-3">{t.cues.loopHint}</p>
              <div className="mt-3 grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    aria-label={t.cues.setIn}
                    onClick={() => usePlayer.getState().setLoopFrom()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                    <span className="cue-label-long">{t.cues.setIn}</span><span className="cue-label-short hidden">IN</span>
                </button>
                  <button
                    type="button"
                    aria-label={t.cues.setOut}
                    onClick={() => usePlayer.getState().setLoopTo()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                    <span className="cue-label-long">{t.cues.setOut}</span><span className="cue-label-short hidden">OUT</span>
                </button>
                <button
                    type="button"
                    aria-label={loop.on ? t.cues.loopOn : t.cues.loopOff}
                    aria-pressed={loop.on}
                    disabled={loop.from == null || loop.to == null || loop.to <= loop.from}
                  onClick={() => usePlayer.getState().toggleLoop()}
                  className={cn(
                    "h-10 rounded-full text-xs font-semibold transition-colors disabled:opacity-40",
                    loop.on ? "bg-accent text-accent-ink" : "bg-surface-3",
                  )}
                >
                    <span className="cue-label-long">{loop.on ? t.cues.loopOn : t.cues.loopOff}</span><span className="cue-label-short hidden">Loop</span>
                </button>
                  <button
                    type="button"
                    aria-label={t.common.close}
                    onClick={() => usePlayer.getState().clearLoop()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                    <span className="cue-label-long">{t.common.close}</span><span className="cue-label-short hidden">Clear</span>
                </button>
              </div>
            </section>

            </div>
            </div>
            </div>
            <div className="cue-playback-transport cue-bottom-playback"><Transport compact/><Scrubber className="cue-scrubber"/></div>
            <Modal open={midiOpen} onClose={()=>setMidiOpen(false)} title={t.cues.midi}>
            <div className="scroll-area max-h-[70dvh] overflow-y-auto">
            <section className="rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">{t.cues.midi}</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-2">
                    {devices.length ? t.cues.midiDevices(devices.length) : t.cues.midiNone}
                  </span>
                  <button
                    type="button"
                    onClick={refreshMidi}
                    aria-label={t.cues.midi}
                    className="grid size-8 place-items-center rounded-full bg-surface-3 text-fg-2 active:scale-90"
                  >
                    <ArrowsClockwiseIcon size={16} />
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-fg-3">{t.cues.midiHint}</p>
              <p className="mt-2 text-xs text-fg-3">{mapping.description ?? "Notes 36–47 · current bank"}</p>
              {devices.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {devices.map((device) => (
                    <li key={device.id} className="truncate rounded-md bg-surface-3 px-2 py-1 text-xs text-fg-2">
                      {device.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {Object.keys(cues).length>0&&<section className="mt-3 rounded-[16px] bg-surface-2 p-3">
              <h3 className="mb-2 text-xs font-semibold">{t.cues.title} · {t.cues.bank} {bank}</h3>
              <div className="grid grid-cols-4 gap-2">{Object.entries(cues).map(([number,time])=><button key={number} type="button" aria-label={`${t.cues.pad(Number(number))}: ${t.common.close}`} onClick={()=>useCueStore.getState().clearCue(Number(number))} className="flex h-9 items-center justify-between rounded-lg bg-surface-3 px-2 text-xs"><span>{number} · {formatTime(time)}</span><span aria-hidden="true">×</span></button>)}</div>
            </section>}
            <div className="mt-3"><Transport/></div>
            </div>
            </Modal>
          </>
        ) : (
          <p className="mt-8 rounded-[16px] bg-surface-2 p-5 text-sm text-fg-2">{t.cues.noTrack}</p>
        )}
      </div>
      <Modal open={samplePad!==null} onClose={()=>setSamplePad(null)} title={samplePad?`Sample pad ${samplePad.bank}${samplePad.pad}`:'Sample pad'}>
        {samplePad&&<div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-fg-2">{samples[`${samplePad.bank}:${samplePad.pad}`]?.name??'No sample loaded. This pad works as a normal cue pad.'}</p>
          {samples[`${samplePad.bank}:${samplePad.pad}`]?.error&&<p role="alert" className="text-sm text-danger">{samples[`${samplePad.bank}:${samplePad.pad}`].error}</p>}
          <p className="text-xs text-fg-3">A loaded sample plays as a one-shot, even without a song. It never marks or jumps to a cue. Remove it to restore normal cue behavior.</p>
          <button type="button" disabled={sampleBusy} className="rounded-full bg-accent px-4 py-2 text-accent-ink" onClick={()=>{setSampleBusy(true);void changePadSample('load',samplePad.bank,samplePad.pad).then(()=>setSamplePad(null)).catch(error=>toast(error.message,'error')).finally(()=>setSampleBusy(false));}}>{sampleBusy?'Loading…':samples[`${samplePad.bank}:${samplePad.pad}`]?'Replace sample…':'Load sample…'}</button>
          {samples[`${samplePad.bank}:${samplePad.pad}`]&&<button type="button" disabled={sampleBusy} className="rounded-full bg-surface-3 px-4 py-2" onClick={()=>{setSampleBusy(true);void changePadSample('remove',samplePad.bank,samplePad.pad).then(()=>setSamplePad(null)).catch(error=>toast(error.message,'error')).finally(()=>setSampleBusy(false));}}>Remove sample</button>}
        </div>}
      </Modal>
    </div>
  );
}
