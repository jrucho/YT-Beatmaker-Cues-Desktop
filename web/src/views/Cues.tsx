import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
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

const formatSemitones = (st: number) => `${st > 0 ? "+" : ""}${st} st`;

/** The playhead clock, on its own so the pad grid is not re-rendered several times a second while playing. */
function CueClock() {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  return (
    <div className="text-right font-mono text-xs text-fg-2">
      <p className="text-fg">{formatTime(position)}</p>
      <p>{formatTime(duration)}</p>
    </div>
  );
}

export default function Cues() {
  const t = useT();
  const track = usePlayer(selectCurrent);
  const loop = usePlayer((s) => s.loop);
  const speed = usePlayer((s) => s.speed);
  const speedMode = usePlayer((s) => s.speedMode);
  const tuning = usePlayer((s) => s.tuning);
  const cues = useCueStore((s) => s.cues);
  const bank = useCueStore((s) => s.bank);
  const nextSlot = useCueStore.getState().nextSlot();
  const nextPad = nextSlot?.pad;
  const [mapping, setMapping] = useState(readControllerPreset);
  const [heldPads, setHeldPads] = useState<Record<string, number>>({});
  const feedback = usePadFeedback();
  const [overwrite, setOverwrite] = useState(false);
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  /** What the finger on a pad is doing: a long press marks the cue instead of playing it. */
  const press = useRef({ timer: null as number | null, marked: false, played: false });
  const faderTap = useRef({ started: 0, startX: 0, startY: 0, previous: 0, previousX: 0, previousY: 0 });

  useEffect(() => {
    useCueStore.getState().setTrack(track?.id ?? null);
  }, [track?.id]);

  const trigger = useCallback((pad: number) => {
    const time = useCueStore.getState().cues[pad];
    if (time == null) return;
    usePlayer.getState().cue(time, { bank: useCueStore.getState().bank, pad });
  }, []);

  const mark = useCallback((pad: number | null, at = cuePosition().catch(() => null)) => {
    const player = usePlayer.getState();
    if (!player.queue[player.index]) return;
    const { trackId, bank } = useCueStore.getState();
    void at.then((position) => {
      const store = useCueStore.getState();
      if (store.trackId !== trackId || store.bank !== bank || position == null || !Number.isFinite(position)) return;
      if (pad == null) store.setNextCue(position);
      else store.setCue(pad, position);
    }).catch(() => {});
  }, []);

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
      mark(pad, at);
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
    if (cues[pad] != null && !overwrite) trigger(pad);
    else mark(pad);
  };

  return (
    <div className="pb-8">
      <PageHeader title={t.cues.title} />

      <div className="px-4">
        <p className="max-w-[46ch] text-sm text-fg-2">{t.cues.subtitle}</p>
        {track ? (
          <>
            <div className="mt-4 flex items-center gap-3 rounded-[16px] bg-surface-2 p-3">
              <Artwork src={track.thumb} className="size-12 rounded-[10px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{track.title}</p>
                <p className="truncate text-xs text-fg-2">{track.artist}</p>
              </div>
              <CueClock />
              <button
                type="button"
                disabled={nextPad == null}
                aria-label={nextPad == null ? t.cues.bankFull : t.cues.markNext(nextPad)}
                onPointerDown={(e) => { if (e.button === 0) mark(null); }}
                onClick={(e) => { if (e.detail === 0) mark(null); }}
                className="h-9 shrink-0 touch-manipulation rounded-full bg-accent px-3 text-xs font-semibold text-accent-ink active:scale-95 disabled:opacity-40"
              >
                {nextPad == null ? t.cues.bankFull : `${t.cues.mark} ${nextSlot?.bank}${nextPad}`}
              </button>
            </div>

            <div className="mt-5 flex items-center gap-2">
              <span className="text-xs font-medium tracking-wide text-fg-3 uppercase">{t.cues.bank}</span>
              <div className="no-scrollbar flex flex-1 gap-1.5 overflow-x-auto">
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
              <button
                type="button"
                onClick={() => useCueStore.getState().clearBank()}
                className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1.5 text-[11px] text-fg-2 active:bg-surface-3"
              >
                {t.cues.clearBank}
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-fg-3">{t.cues.markHint}</p>
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

            <div className={cn("mt-3 grid gap-2", mapping.padToNote.length === 12 ? "grid-cols-3" : "grid-cols-4")}>
              {Array.from({ length: mapping.padToNote.length }, (_, i) => i + 1).map((pad) => {
                const time = cues[pad];
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
                      aria-label={time == null ? `${t.cues.pad(pad)}: ${t.cues.empty}` : `${t.cues.pad(pad)}: ${formatTime(time)}`}
                      className={cn(
                        "flex aspect-[1.45] w-full touch-none flex-col justify-between rounded-[14px] p-2.5 text-left transition-[transform,background-color] select-none active:scale-[0.97]",
                        time == null
                          ? "bg-surface-2 ring-1 ring-line active:bg-surface-3"
                          : "bg-accent-soft text-accent-text ring-1 ring-accent/30",
                        heldPads[`${bank}:${pad}`] ? "brightness-150 ring-2 ring-accent" : "",
                        feedback.pressed.has(`${bank}:${pad}`) || feedback.flashing.has(`${bank}:${pad}`) ? "brightness-150 ring-2 ring-accent scale-[0.97]" : "",
                      )}
                    >
                      <span className={cn("text-xs font-semibold", time == null ? "text-fg-3" : "text-accent-text")}>
                        {pad}
                      </span>
                      <span className={cn("font-mono text-[11px]", time == null ? "text-fg-3" : "text-accent-text")}>
                        {time == null ? t.cues.empty : formatTime(time)}
                      </span>
                    </button>
                    {time != null && (
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

            <section className="mt-6 rounded-[16px] bg-surface-2 p-4">
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
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] leading-snug text-fg-3">{t.cues.semitoneNote}</p>
                  <div className="flex shrink-0 gap-1 rounded-full bg-surface-3 p-1">
                    <button
                      type="button"
                      aria-label={t.cues.semitoneDown}
                      disabled={tuning <= -12}
                      onClick={() => usePlayer.getState().setTuning(tuning - 1)}
                      className="h-8 rounded-full px-2.5 text-[11px] font-semibold active:bg-surface-4 disabled:opacity-40"
                    >
                      −1 st
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
                      +1 st
                    </button>
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <div className="grid flex-1 grid-cols-2 gap-1 rounded-full bg-surface-3 p-1">
                  <button
                    type="button"
                    onClick={() => usePlayer.getState().setSpeedMode("pitch")}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-semibold transition-colors",
                      speedMode === "pitch" ? "bg-accent text-accent-ink" : "text-fg-2",
                    )}
                  >
                    {t.cues.pitchMode}
                  </button>
                  <button
                    type="button"
                    onClick={() => usePlayer.getState().setSpeedMode("speed")}
                    className={cn(
                      "h-8 rounded-full text-[11px] font-semibold transition-colors",
                      speedMode === "speed" ? "bg-accent text-accent-ink" : "text-fg-2",
                    )}
                  >
                    {t.cues.speedMode}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    usePlayer.getState().setSpeed(0);
                    if (speedMode === "speed") usePlayer.getState().setTuning(0);
                  }}
                  className="h-10 rounded-full bg-surface-3 px-3 text-xs font-semibold active:scale-95"
                >
                  {t.cues.reset}
                </button>
              </div>
            </section>

            <section className="mt-4 rounded-[16px] bg-surface-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{t.cues.loop}</h2>
                <span className="font-mono text-xs text-fg-2">
                  {loop.from == null ? "—" : formatTime(loop.from)} → {loop.to == null ? "—" : formatTime(loop.to)}
                </span>
              </div>
              <p className="mt-1 text-xs text-fg-3">{t.cues.loopHint}</p>
              <div className="mt-3 grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => usePlayer.getState().setLoopFrom()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                  {t.cues.setIn}
                </button>
                <button
                  type="button"
                  onClick={() => usePlayer.getState().setLoopTo()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                  {t.cues.setOut}
                </button>
                <button
                  type="button"
                  disabled={loop.from == null || loop.to == null || loop.to <= loop.from}
                  onClick={() => usePlayer.getState().toggleLoop()}
                  className={cn(
                    "h-10 rounded-full text-xs font-semibold transition-colors disabled:opacity-40",
                    loop.on ? "bg-accent text-accent-ink" : "bg-surface-3",
                  )}
                >
                  {loop.on ? t.cues.loopOn : t.cues.loopOff}
                </button>
                <button
                  type="button"
                  onClick={() => usePlayer.getState().clearLoop()}
                  className="h-10 rounded-full bg-surface-3 text-xs font-semibold active:scale-95"
                >
                  {t.common.close}
                </button>
              </div>
            </section>

            <section className="mt-4 rounded-[16px] bg-surface-2 p-4">
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
              <select aria-label="MIDI controller preset" value={mapping.id}
                className="mt-3 w-full rounded-md bg-surface-3 p-2 text-xs"
                onChange={event => {
                  const preset = CONTROLLER_PRESETS.find(p => p.id === event.target.value)!;
                  saveControllerPreset(preset.id); setMapping(preset); setHeldPads({});
                }}>
                {CONTROLLER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
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
          </>
        ) : (
          <p className="mt-8 rounded-[16px] bg-surface-2 p-5 text-sm text-fg-2">{t.cues.noTrack}</p>
        )}
      </div>
    </div>
  );
}
