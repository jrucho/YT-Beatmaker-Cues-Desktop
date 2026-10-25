import { create } from "zustand";
import { getT, useT } from "../i18n";
import { api, capabilities, explainStreamError, streamSource, systemMedia, type ApiError, type ErrorCode } from "../lib/api";
import { createAudio, cueAudio, readAudioPosition, setAudioLoop, setAudioPlaylist, setAudioStart, setAudioTuning, supportsIndependentPitch } from "../lib/audio";
import { shuffled } from "../lib/format";
import type { Track } from "../lib/types";
import { useLibrary } from "../stores/library";
import { openSettings } from "../stores/system";
import { toast } from "../stores/ui";

export type Repeat = "off" | "all" | "one";
/** A code translated where it is shown (so switching languages updates it), or a server error already in the right language. */
export type StatusNote = "findingClip" | "preparingHd" | "loadingVideo" | "fetchingRadio" | { error: string };
export type Status = "idle" | "loading" | "playing" | "paused" | "error";
export type SpeedMode = "pitch" | "speed";
export interface CueLoop {
  from: number | null;
  to: number | null;
  on: boolean;
}
type Kind = "audio" | "video";
type Quality = "sd" | "hd";

interface PlayerState {
  queue: Track[];
  /** Queue order before shuffle was turned on, restored when it is turned off. */
  original: Track[] | null;
  index: number;
  status: Status;
  /** What playback is busy with (or why it failed), shown instead of the artist. See `useStatusText`. */
  statusText: StatusNote | null;
  /** Which media element is driving playback right now. */
  mediaKind: Kind;
  /** Set when Video mode is on but the current song has no music video on YouTube. */
  videoNote: "noClip" | null;
  /** Intrinsic width/height of the current video, so vertical videos get a vertical stage. */
  videoAspect: number;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  autoRadio: boolean;
  loop: CueLoop;
  /** Playback rate change in percent: 0 is normal speed, +100 is double speed. */
  speed: number;
  /** "pitch" is varispeed (rate changes pitch); "speed" keeps the original pitch. */
  speedMode: SpeedMode;
  /** Independent key shift in semitones, used only in pitch-kept mode. */
  tuning: number;

  playList: (tracks: Track[], start?: number) => void;
  playTrack: (track: Track) => void;
  playNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  removeAt: (i: number) => void;
  jumpTo: (i: number) => void;
  clearUpcoming: () => void;
  startRadio: (track: Track) => Promise<void>;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  /** Jumps to a cue point as fast as possible: the loaded stream is only re-seeked, never reloaded. */
  cue: (seconds: number, pad?: { bank: string; pad: number }) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setPreferVideo: (on: boolean) => void;
  setQuality: (q: Quality) => void;
  setAutoRadio: (on: boolean) => void;
  setLoopFrom: (seconds?: number) => void;
  setLoopTo: (seconds?: number) => void;
  toggleLoop: () => void;
  clearLoop: () => void;
  setSpeed: (percent: number) => void;
  setSpeedMode: (mode: SpeedMode) => void;
  setTuning: (semitones: number) => void;
}

// Media elements live outside React so playback survives any re-render or route change.
// On iOS this is the native player behind the same API (see lib/audio.ts).
const audio = createAudio();

export const videoEl = document.createElement("video");
videoEl.playsInline = true;
videoEl.preload = "auto";
videoEl.setAttribute("playsinline", "");
videoEl.className = "block h-full w-full object-contain bg-black";

const mediaFor = (k: Kind): HTMLMediaElement => (k === "video" ? videoEl : audio);

/** The Beatmaker engine processes the very same media element as the music player. */
export const beatmakerMedia = () => mediaFor(usePlayer.getState().mediaKind);
export const independentTuningAvailable = supportsIndependentPitch(audio);

/** Mark cues from the actual playhead, rather than the UI's throttled position. */
export const cuePosition = () => loaded ? readAudioPosition(mediaFor(loaded.kind)) : Promise.resolve(usePlayer.getState().position);

let loaded: { id: string; kind: Kind; quality: Quality } | null = null;
let pendingSeek = 0;
let token = 0;
let recordedToken = -1;

const STORAGE_KEY = "musike:player";
const LOOPS_KEY = "musike:loops";

interface Saved {
  queue: Track[];
  original: Track[] | null;
  index: number;
  position: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  autoRadio: boolean;
  speed: number;
  speedMode: SpeedMode;
  tuning: number;
}

interface Loops {
  [trackId: string]: { from: number | null; to: number | null; on: boolean };
}

function readLoops(): Loops {
  try {
    const data = JSON.parse(localStorage.getItem(LOOPS_KEY) ?? "{}") as Loops;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeLoop(trackId: string, loop: CueLoop) {
  const loops = readLoops();
  if (loop.from == null && loop.to == null) delete loops[trackId];
  else loops[trackId] = { from: loop.from, to: loop.to, on: loop.on };
  try {
    localStorage.setItem(LOOPS_KEY, JSON.stringify(loops));
  } catch {
    /* storage full or blocked */
  }
}

function readSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}

const saved = readSaved();
const initialLoop = (): CueLoop => {
  const track = saved.queue?.[saved.index ?? 0];
  const loop = track ? readLoops()[track.id] : undefined;
  return { from: loop?.from ?? null, to: loop?.to ?? null, on: loop?.on ?? false };
};

/**
 * Songs from YouTube Music are "art tracks": audio with a still cover. In Video mode we play the
 * song's music video instead. Song id → video id, or null when YouTube has no clip for it.
 */
const clipFor = new Map<string, string | null>();
const clipLookups = new Map<string, Promise<string | null>>();

function lookupClip(track: Track): Promise<string | null> {
  if (track.kind === "video") return Promise.resolve(track.id);
  if (clipFor.has(track.id)) return Promise.resolve(clipFor.get(track.id)!);
  let lookup = clipLookups.get(track.id);
  if (!lookup) {
    lookup = api
      .videoFor(track)
      .then(
        (v) => {
          const id = v?.id ?? null;
          clipFor.set(track.id, id);
          return id;
        },
        () => null, // network hiccup: don't remember it, try again next time
      )
      .finally(() => clipLookups.delete(track.id));
    clipLookups.set(track.id, lookup);
  }
  return lookup;
}

const needsClipLookup = (track: Track, preferVideo: boolean) =>
  preferVideo && track.kind === "song" && !clipFor.has(track.id);

export const usePlayer = create<PlayerState>((set, get) => {
  const kindFor = (track: Track): Kind =>
    capabilities.video && get().preferVideo && (track.kind === "video" || !!clipFor.get(track.id)) ? "video" : "audio";
  /** The YouTube id to stream: the song itself, or its music video in Video mode. */
  const mediaIdFor = (track: Track, kind: Kind) =>
    kind === "video" && track.kind !== "video" ? clipFor.get(track.id)! : track.id;
  const noteFor = (track: Track) =>
    get().preferVideo && track.kind === "song" && clipFor.get(track.id) === null ? ("noClip" as const) : null;
  const activeMedia = (): HTMLMediaElement | null => (loaded ? mediaFor(loaded.kind) : null);

  /** Applies the current speed and pitch mode to a media element. */
  function applyPlaybackRate(media: HTMLMediaElement) {
    const { speed, speedMode, tuning } = get();
    const rate = Math.min(4, Math.max(0.25, 1 + speed / 100));
    if (Math.abs(media.playbackRate - rate) > 0.001) media.playbackRate = rate;
    const preserve = speedMode === "speed";
    try {
      media.preservesPitch = preserve;
      (media as HTMLMediaElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = preserve;
    } catch {
      /* older engines only support playbackRate */
    }
    setAudioTuning(media, tuning);
  }

  /** Stores loop points for the current track and keeps the enabled loop in sync. */
  function saveLoop(loop: CueLoop) {
    const track = get().queue[get().index];
    set({ loop });
    setAudioLoop(audio, loop);
    if (track) writeLoop(track.id, loop);
  }

  function play(media: HTMLMediaElement) {
    applyPlaybackRate(media);
    media.play().catch((err: DOMException) => {
      if (err.name === "AbortError") return; // src changed mid-start
      if (err.name === "NotAllowedError") set({ status: "paused" }); // autoplay blocked
    });
  }

  function load(index: number, opts: { autoplay?: boolean; startAt?: number } = {}) {
    const s = get();
    const track = s.queue[index];
    if (!track) return;

    // Video mode on a song: find its music video first, then load whichever fits.
    if (needsClipLookup(track, s.preferVideo)) {
      const mine = ++token;
      set({
        index,
        status: "loading",
        statusText: "findingClip",
        videoNote: null,
        position: opts.startAt ?? 0,
        duration: track.duration,
        buffered: 0,
      });
      activeMedia()?.pause();
      setMetadata(track);
      void lookupClip(track).then(() => mine === token && load(index, opts));
      return;
    }

    const kind = kindFor(track);
    const media = mediaFor(kind);
    const other = mediaFor(kind === "video" ? "audio" : "video");
    other.pause();
    if (other.getAttribute("src")) {
      other.removeAttribute("src");
      other.load();
    }

    token++;
    loaded = { id: track.id, kind, quality: s.quality };
    pendingSeek = opts.startAt ?? 0;
    const autoplay = opts.autoplay !== false;
    set({
      index,
      mediaKind: kind,
      status: autoplay ? "loading" : "paused",
      // Video may need a server-side download first (HD, or videos without a combined SD stream).
      statusText: kind === "video" ? (s.quality === "hd" ? "preparingHd" : "loadingVideo") : null,
      videoNote: noteFor(track),
      position: pendingSeek,
      duration: track.duration,
      buffered: 0,
    });
    media.volume = s.volume;
    media.muted = s.muted;
    applyPlaybackRate(media);
    const savedLoop = readLoops()[track.id];
    const loop = { from: savedLoop?.from ?? null, to: savedLoop?.to ?? null, on: savedLoop?.on ?? false };
    set({ loop });
    setAudioLoop(audio, loop);
    const start = (src: string) => {
      setAudioStart(media, pendingSeek);
      media.src = src;
      if (autoplay) play(media);
    };
    // The server's proxy URL is known right away; on Android the stream is first resolved on the phone.
    const source = streamSource(mediaIdFor(track, kind), kind, s.quality);
    if (typeof source === "string") start(source);
    else {
      const mine = token;
      source.then(
        (src) => mine === token && start(src),
        (err: ApiError) => mine === token && report(err.message, err.code),
      );
    }
    setMetadata(track);
  }

  async function continueWithRadio() {
    const s = get();
    const last = s.queue[s.index];
    if (!last) return;
    set({ status: "loading", statusText: "fetchingRadio" });
    try {
      const known = new Set(get().queue.map((t) => t.id));
      const more = (await api.radio(last.id)).filter((t) => !known.has(t.id)).slice(0, 25);
      if (!more.length) throw new Error("empty");
      set((st) => ({
        queue: [...st.queue, ...more],
        original: st.original ? [...st.original, ...more] : null,
      }));
      toast(getT().player.radioContinuing(last.title));
      load(get().index + 1);
    } catch {
      set({ status: "paused", statusText: null, position: 0 });
    }
  }

  function onStarted() {
    const s = get();
    const track = s.queue[s.index];
    if (!track || recordedToken === token) return;
    recordedToken = token;
    useLibrary.getState().recordPlay(track);
    // Warm up the next track (and, in Video mode, find and resolve its clip) so it starts quickly.
    const upcoming = s.queue[s.index + 1];
    if (!upcoming) return;
    if (s.preferVideo) void lookupClip(upcoming).then((id) => api.prepare(id ?? upcoming.id).catch(() => {}));
    else api.prepare(upcoming.id).catch(() => {});
  }

  function onEnded() {
    const s = get();
    if (s.loop.on && s.loop.from != null) {
      const media = activeMedia();
      if (media) {
        media.currentTime = s.loop.from;
        set({ position: s.loop.from });
        play(media);
      }
      return;
    }
    if (s.repeat === "one") {
      const media = activeMedia();
      if (media) {
        media.currentTime = 0;
        play(media);
      }
      return;
    }
    if (s.index < s.queue.length - 1) return load(s.index + 1);
    if (s.repeat === "all" && s.queue.length) return load(0);
    if (s.autoRadio) return void continueWithRadio();
    set({ status: "paused", position: 0 });
  }

  /** Shows why a track can't play, then moves on (unless every track would fail the same way). */
  function report(message: string, code?: ErrorCode) {
    const mine = token;
    set({ status: "error", statusText: { error: message } });
    const track = get().queue[get().index];
    // Tool problems hit every track: offer the fix instead of skipping through the whole queue.
    const toolProblem = code === "tool_missing" || code === "maybe_outdated";
    const t = getT();
    toast(
      t.player.cantPlay(track?.title ?? t.player.aTrack, message),
      "error",
      toolProblem ? { label: code === "tool_missing" ? t.common.install : t.common.update, run: openSettings } : undefined,
    );
    if (code !== "tool_missing" && get().index < get().queue.length - 1) {
      setTimeout(() => mine === token && get().next(), 2500);
    }
  }

  // A stream URL that expired mid-song gets one fresh try from the same spot before giving up.
  let retriedToken = -1;

  function onError(media: HTMLMediaElement) {
    const mine = token;
    const url = media.currentSrc || media.src;
    if (capabilities.retryOnError && retriedToken !== mine) {
      const at = media.currentTime || get().position;
      load(get().index, { startAt: at, autoplay: true });
      retriedToken = token;
      return;
    }
    set({ status: "error" });
    explainStreamError(url).then(({ message, code }) => {
      if (mine === token) report(message, code);
    });
  }

  function wire(media: HTMLMediaElement) {
    const isActive = () => activeMedia() === media;
    media.addEventListener("nativetrackchange", (event) => {
      const data = (event as CustomEvent<{ queueIndex: number; trackId: string; position?: number; duration?: number; buffered?: number; playing?: boolean; ready?: boolean; resume?: boolean; loop?: CueLoop }>).detail;
      const track = get().queue[data.queueIndex];
      if (!track || track.id !== data.trackId || media !== audio) return;
      if (data.resume && !loaded) {
        set({ index: data.queueIndex, position: data.position ?? get().position, duration: track.duration, status: "paused", statusText: null });
        return;
      }
      // A cold native player can know the queue without having loaded any audio.
      // Do not let that empty snapshot replace the saved position or mark it loaded.
      if (!data.ready && !data.playing) return;
      const changed = loaded?.id !== track.id || get().index !== data.queueIndex;
      if (changed) token++;
      loaded = { id: track.id, kind: "audio", quality: get().quality };
      pendingSeek = 0;
      set({ index: data.queueIndex, mediaKind: "audio", position: data.position ?? 0,
        duration: data.duration || track.duration, buffered: data.buffered ?? 0,
        status: data.playing === false ? "paused" : data.ready ? "playing" : "loading", statusText: null,
        loop: data.loop ?? { from: null, to: null, on: false } });
      if (changed) { setMetadata(track); onStarted(); }
      syncPlaybackState();
    });
    media.addEventListener("loadedmetadata", () => {
      if (!isActive()) return;
      if (pendingSeek > 0) {
        if (Math.abs(media.currentTime - pendingSeek) > 0.001) media.currentTime = pendingSeek;
        pendingSeek = 0;
      }
      if (Number.isFinite(media.duration)) set({ duration: media.duration });
      applyPlaybackRate(media);
      if (media === videoEl && videoEl.videoWidth && videoEl.videoHeight) {
        set({ videoAspect: videoEl.videoWidth / videoEl.videoHeight });
      }
      syncPositionState();
    });
    media.addEventListener("durationchange", () => {
      if (isActive() && Number.isFinite(media.duration)) set({ duration: media.duration });
    });
    media.addEventListener("playing", () => {
      if (!isActive()) return;
      set({ status: "playing", statusText: null });
      onStarted();
      syncPlaybackState();
    });
    media.addEventListener("pause", () => {
      if (!isActive() || media.ended || get().status === "loading" || get().status === "error") return;
      set({ status: "paused" });
      syncPlaybackState();
    });
    media.addEventListener("waiting", () => {
      if (isActive() && !media.paused) set({ status: "loading" });
    });
    media.addEventListener("timeupdate", () => {
      if (!isActive() || pendingSeek > 0) return;
      const loop = get().loop;
      if (!supportsIndependentPitch(media) && !media.seeking && loop.on && loop.to != null && media.currentTime >= loop.to) {
        const from = Math.max(0, Math.min(loop.from ?? 0, loop.to - 0.05));
        media.currentTime = from;
        set({ position: from });
        syncSystemMedia();
        return;
      }
      if (Math.abs(media.currentTime - get().position) >= 0.2) set({ position: media.currentTime });
      syncSystemMedia(); // throttled on the other side
    });
    media.addEventListener("progress", () => {
      if (!isActive() || !media.buffered.length) return;
      set({ buffered: media.buffered.end(media.buffered.length - 1) });
    });
    media.addEventListener("seeked", () => isActive() && syncPositionState());
    media.addEventListener("ended", () => isActive() && onEnded());
    media.addEventListener("error", () => isActive() && media.getAttribute("src") && onError(media));
  }
  wire(audio);
  wire(videoEl);

  const reloadIfKindChanged = () => {
    const s = get();
    const track = s.queue[s.index];
    if (!track) return;
    set({ videoNote: noteFor(track) });
    if (!loaded || loaded.id !== track.id) return;
    const wasPlaying = s.status === "playing" || s.status === "loading";
    if (needsClipLookup(track, s.preferVideo)) return load(s.index, { startAt: s.position, autoplay: wasPlaying });
    const kind = kindFor(track);
    if (loaded.kind === kind && (kind === "audio" || loaded.quality === s.quality)) return;
    load(s.index, { startAt: s.position, autoplay: wasPlaying });
  };

  return {
    queue: saved.queue ?? [],
    original: saved.original ?? null,
    index: saved.index ?? 0,
    status: saved.queue?.length ? "paused" : "idle",
    statusText: null,
    mediaKind: "audio",
    videoNote: null,
    videoAspect: 16 / 9,
    position: saved.position ?? 0,
    duration: saved.queue?.[saved.index ?? 0]?.duration ?? 0,
    buffered: 0,
    volume: saved.volume ?? 0.9,
    muted: saved.muted ?? false,
    shuffle: saved.shuffle ?? false,
    repeat: saved.repeat ?? "off",
    // Builds without video (Android) always play audio, whatever a backup or an old session says.
    preferVideo: capabilities.video && (saved.preferVideo ?? false),
    quality: saved.quality ?? "sd",
    autoRadio: saved.autoRadio ?? true,
    loop: initialLoop(),
    speed: Math.min(100, Math.max(-50, saved.speed ?? 0)),
    speedMode: saved.speedMode === "pitch" ? "pitch" : "speed",
    tuning: Number.isFinite(saved.tuning) ? Math.max(-12, Math.min(12, Math.round(saved.tuning!))) : 0,

    playList: (tracks, start = 0) => {
      if (!tracks.length) return;
      const first = tracks[start] ?? tracks[0];
      if (get().shuffle) {
        const rest = tracks.filter((_, i) => i !== start);
        set({ queue: [first, ...shuffled(rest)], original: tracks.slice() });
        load(0);
      } else {
        set({ queue: tracks.slice(), original: null });
        load(start);
      }
    },

    playTrack: (track) => {
      const s = get();
      const at = s.queue.findIndex((t) => t.id === track.id);
      if (at >= 0) return load(at);
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      load(insert);
    },

    playNext: (track) => {
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      toast(getT().player.playsNext(track.title));
    },

    addToQueue: (track) => {
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      set({ queue: [...s.queue, track], original: s.original ? [...s.original, track] : null });
      toast(getT().player.addedToQueue(track.title));
    },

    removeAt: (i) => {
      const s = get();
      if (i < 0 || i >= s.queue.length) return;
      const removed = s.queue[i];
      const queue = s.queue.filter((_, j) => j !== i);
      const original = s.original?.filter((t) => t !== removed) ?? null;
      if (i < s.index) return set({ queue, original, index: s.index - 1 });
      if (i > s.index) return set({ queue, original });
      // Removing the current track: move on to whatever takes its place.
      set({ queue, original });
      if (queue[i]) load(i, { autoplay: s.status === "playing" });
      else {
        activeMedia()?.pause();
        loaded = null;
        set({ index: Math.max(0, queue.length - 1), status: queue.length ? "paused" : "idle", position: 0 });
      }
    },

    jumpTo: (i) => load(i),

    clearUpcoming: () => {
      const s = get();
      const keep = s.queue.slice(0, s.index + 1);
      set({ queue: keep, original: s.original ? keep.slice() : null });
    },

    startRadio: async (track) => {
      toast(getT().player.startingRadio(track.title));
      try {
        const related = await api.radio(track.id);
        get().playList([track, ...related.filter((t) => t.id !== track.id)], 0);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },

    toggle: () => {
      const s = get();
      const track = s.queue[s.index];
      if (!track) return;
      const kind = kindFor(track);
      const stale =
        !loaded ||
        loaded.id !== track.id ||
        loaded.kind !== kind ||
        (kind === "video" && loaded.quality !== s.quality) ||
        needsClipLookup(track, s.preferVideo);
      if (stale || s.status === "error") return load(s.index, { startAt: s.position });
      const media = mediaFor(kind);
      if (media.paused) play(media);
      else media.pause();
    },

    next: () => {
      const s = get();
      if (s.index < s.queue.length - 1) return load(s.index + 1);
      if (s.repeat === "all" && s.queue.length) return load(0);
      if (s.autoRadio) void continueWithRadio();
    },

    prev: () => {
      const s = get();
      if (s.position > 3 || s.index === 0) return get().seek(0);
      load(s.index - 1);
    },

    seek: (seconds) => {
      const t = Math.max(0, Math.min(seconds, get().duration || seconds));
      set({ position: t });
      const media = activeMedia();
      const track = get().queue[get().index];
      if (!media || !track || loaded?.id !== track.id || media.readyState === 0) {
        pendingSeek = t;
        return;
      }
      media.currentTime = t;
    },

    // Cue pads are an instrument: a hit must be heard now, so this only re-seeks the stream that is already
    // loaded. `seek` alone is not enough (it leaves a paused track paused) and `toggle` may reload the track.
    cue: (seconds, pad) => {
      const s = get();
      const track = s.queue[s.index];
      if (!track) return;
      const kind = kindFor(track);
      const media = mediaFor(kind);
      const t = Math.max(0, Math.min(seconds, s.duration || seconds));
      // An explicit cue outside the loop must be audible, not immediately bounced back to IN.
      if (s.loop.on && (t < (s.loop.from ?? 0) || (s.loop.to != null && t >= s.loop.to - 0.03))) {
        saveLoop({ ...s.loop, on: false });
      }
      const ready =
        !!loaded && loaded.id === track.id && loaded.kind === kind && media.readyState > 0 && !needsClipLookup(track, s.preferVideo);
      if (!ready) return load(s.index, { startAt: seconds });
      set({ position: t });
      if (cueAudio(media, t, pad)) return;
      media.currentTime = t;
      if (media.paused) play(media);
      if (pad) window.dispatchEvent(new CustomEvent("beatmaker-pad", { detail: { ...pad, phase: "triggered" } }));
    },

    setVolume: (v) => {
      const volume = Math.max(0, Math.min(1, v));
      audio.volume = videoEl.volume = volume;
      const muted = volume === 0 ? true : false;
      audio.muted = videoEl.muted = muted;
      set({ volume, muted });
    },

    toggleMute: () => {
      const muted = !get().muted;
      audio.muted = videoEl.muted = muted;
      if (!muted && get().volume === 0) get().setVolume(0.6);
      else set({ muted });
    },

    toggleShuffle: () => {
      const s = get();
      const current = s.queue[s.index];
      if (!s.shuffle) {
        const rest = s.queue.filter((_, i) => i !== s.index);
        set({ shuffle: true, original: s.queue, queue: current ? [current, ...shuffled(rest)] : shuffled(rest), index: 0 });
        return;
      }
      const present = new Set(s.queue);
      const base = (s.original ?? s.queue).filter((t) => present.has(t));
      const extra = s.queue.filter((t) => !base.includes(t));
      const queue = [...base, ...extra];
      set({ shuffle: false, original: null, queue, index: Math.max(0, current ? queue.indexOf(current) : 0) });
    },

    cycleRepeat: () => {
      const order: Repeat[] = ["off", "all", "one"];
      set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
    },

    setPreferVideo: (on) => {
      if (on && !capabilities.video) return;
      set({ preferVideo: on });
      reloadIfKindChanged();
    },

    setQuality: (quality) => {
      set({ quality });
      reloadIfKindChanged();
    },

    setAutoRadio: (autoRadio) => set({ autoRadio }),

    setLoopFrom: (seconds) => {
      if (!get().queue[get().index]) return;
      if (seconds == null) {
        const mine = token;
        void cuePosition().then((at) => { if (mine === token) get().setLoopFrom(at); }).catch(() => {});
        return;
      }
      if (!Number.isFinite(seconds)) return;
      const from = Math.max(0, Math.min(seconds ?? get().position, get().duration || Number.POSITIVE_INFINITY));
      const to = get().loop.to;
      // A loop with both edges is meant to play: it switches on by itself as soon as the second one is set.
      const next = to != null && to > from ? { from, to, on: true } : { from, to: null, on: false };
      saveLoop(next);
    },

    setLoopTo: (seconds) => {
      if (!get().queue[get().index]) return;
      if (seconds == null) {
        const mine = token;
        void cuePosition().then((at) => { if (mine === token) get().setLoopTo(at); }).catch(() => {});
        return;
      }
      if (!Number.isFinite(seconds)) return;
      const to = Math.max(0, Math.min(seconds ?? get().position, get().duration || Number.POSITIVE_INFINITY));
      const from = get().loop.from;
      const next = from != null && from < to ? { from, to, on: true } : { from: null, to, on: false };
      saveLoop(next);
    },

    toggleLoop: () => {
      const loop = get().loop;
      if (loop.from == null || loop.to == null || loop.to <= loop.from) return;
      const on = !loop.on;
      saveLoop({ ...loop, on });
      if (on && (get().position < loop.from || get().position >= loop.to)) get().seek(loop.from);
    },

    clearLoop: () => {
      if (!get().queue[get().index]) return;
      saveLoop({ from: null, to: null, on: false });
    },

    setSpeed: (percent) => {
      const speed = Math.min(100, Math.max(-50, Math.round(percent)));
      set({ speed });
      applyPlaybackRate(audio);
      applyPlaybackRate(videoEl);
    },

    setSpeedMode: (speedMode) => {
      set({ speedMode });
      applyPlaybackRate(audio);
      applyPlaybackRate(videoEl);
    },

    setTuning: (semitones) => {
      if (!independentTuningAvailable || !Number.isFinite(semitones)) return;
      set({ tuning: Math.max(-12, Math.min(12, Math.round(semitones))) });
      applyPlaybackRate(audio);
    },
  };
});

audio.volume = videoEl.volume = usePlayer.getState().volume;
audio.muted = videoEl.muted = usePlayer.getState().muted;
{
  const { speed, speedMode, tuning } = usePlayer.getState();
  for (const media of [audio, videoEl]) {
    const rate = Math.min(4, Math.max(0.25, 1 + speed / 100));
    media.playbackRate = rate;
    media.preservesPitch = speedMode === "speed";
    (media as HTMLMediaElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = speedMode === "speed";
    setAudioTuning(media, tuning);
  }
}

export const selectCurrent = (s: PlayerState): Track | null => s.queue[s.index] ?? null;

function syncNativePlaylist() {
  if (!independentTuningAvailable) return;
  const s = usePlayer.getState();
  const loops = readLoops();
  setAudioPlaylist(audio, { index: s.index, repeat: s.repeat, tracks: s.queue.map((track, index) => ({
    id: track.id, title: track.title, artist: track.artist, album: track.album,
    artwork: track.art || track.thumb, duration: track.duration,
    loop: index === s.index ? s.loop : loops[track.id] ?? { from: null, to: null, on: false },
  })) });
}
usePlayer.subscribe((state, previous) => {
  if (state.queue !== previous.queue || state.index !== previous.index || state.repeat !== previous.repeat || state.loop !== previous.loop) syncNativePlaylist();
});
syncNativePlaylist();

/** Whether the track can be shown as video (art tracks are audio with a still image). */

// Persistence: resume the same queue and position after a reload.

function persist() {
  const s = usePlayer.getState();
  const data: Saved = {
    queue: s.queue.slice(0, 500),
    original: s.original?.slice(0, 500) ?? null,
    index: s.index,
    position: s.position,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    preferVideo: s.preferVideo,
    quality: s.quality,
    autoRadio: s.autoRadio,
    speed: s.speed,
    speedMode: s.speedMode,
    tuning: s.tuning,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or blocked */
  }
}
setInterval(persist, 1000);
usePlayer.subscribe((state, previous) => {
  if (state.status !== previous.status || state.index !== previous.index || state.queue !== previous.queue) persist();
});
addEventListener("pagehide", persist);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && persist());

// Media Session: lock-screen, headset and notification controls.

function setMetadata(track: Track) {
  systemMedia?.setTrack({ title: track.title, artist: track.artist, album: track.album ?? "", artwork: track.art || track.thumb });
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    artwork:
      track.kind === "video"
        ? [
            { src: track.art, sizes: "1280x720", type: "image/jpeg" },
            { src: track.thumb, sizes: "320x180", type: "image/jpeg" },
          ]
        : [{ src: track.art, sizes: "544x544", type: "image/jpeg" }],
  });
}

/** The phone's notification and lock screen. A track that is loading is about to play, so it counts as playing:
 *  reporting a pause between tracks would let Android stop the app in the background. */
function syncSystemMedia() {
  if (!systemMedia) return;
  const { status, position, duration } = usePlayer.getState();
  systemMedia.setState({ playing: status === "playing" || status === "loading", position, duration });
}

function syncPlaybackState() {
  syncSystemMedia();
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = usePlayer.getState().status === "playing" ? "playing" : "paused";
  syncPositionState();
}

function syncPositionState() {
  syncSystemMedia();
  const { duration, position } = usePlayer.getState();
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    const rate = loaded ? mediaFor(loaded.kind).playbackRate : 1;
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: Math.min(4, Math.max(0.25, rate)),
    });
  } catch {
    /* some browsers reject transient states */
  }
}

if (systemMedia) {
  const p = () => usePlayer.getState();
  systemMedia.onAction((action, position) => {
    if (action === "play" && p().status !== "playing") p().toggle();
    else if (action === "pause" && p().status === "playing") p().toggle();
    else if (action === "next") p().next();
    else if (action === "previous") p().prev();
    else if (action === "seek" && position != null) p().seek(position);
  });
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const p = () => usePlayer.getState();
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => p().status !== "playing" && p().toggle()],
    ["pause", () => p().status === "playing" && p().toggle()],
    ["previoustrack", () => p().prev()],
    ["nexttrack", () => p().next()],
    ["seekto", (d) => d.seekTime != null && p().seek(d.seekTime)],
    ["seekbackward", (d) => p().seek(p().position - (d.seekOffset ?? 10))],
    ["seekforward", (d) => p().seek(p().position + (d.seekOffset ?? 10))],
  ];
  for (const [action, handler] of handlers) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      /* action not supported */
    }
  }
  const restored = selectCurrent(usePlayer.getState());
  if (restored) setMetadata(restored);
}

/** The player's status line in the current language, or null when there is nothing to say. */
export function useStatusText(): string | null {
  const note = usePlayer((s) => s.statusText);
  const t = useT();
  if (note === null) return null;
  return typeof note === "string" ? t.player.status[note] : note.error;
}
