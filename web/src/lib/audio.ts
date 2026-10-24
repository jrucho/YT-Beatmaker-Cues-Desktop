import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * The audio element the player drives.
 *
 * On iOS it is not an `<audio>` at all: the web view's media stack gets cut off by YouTube a few hundred kilobytes
 * into a track (the element pauses, silently, around fifteen seconds), so the app plays natively through the
 * `musikeAudio` handler (ios/App/App/MusikeAudio.swift). Cached files feed AVAudioEngine with native cue/loop
 * scheduling and independent speed/tuning. This class keeps the slice of the HTMLMediaElement API the
 * player uses — src, play, pause, currentTime, duration, volume, buffered and the events — backed by that player.
 *
 * On Android it is native too (MusikeAudioPlugin.java): ExoPlayer with a local cache, because seeking a remote
 * stream in the web view was what made the cue pads lag.
 *
 * Everywhere else it is the plain `<audio>` the app has always used.
 */

interface Bridge {
  postMessage(message: unknown): void;
  position?(sourceId: number): Promise<number>;
  snapshot?(): Promise<NativePayload>;
}

export interface NativePlaylist {
  index: number;
  repeat: "off" | "all" | "one";
  tracks: { id: string; title: string; artist: string; album?: string; artwork: string; duration: number; loop: AudioLoop }[];
}

interface AudioLoop {
  from: number | null;
  to: number | null;
  on: boolean;
}

interface NativePayload {
  sourceId?: number;
  position?: number;
  duration?: number;
  buffered?: number;
  message?: string;
  queueIndex?: number;
  trackId?: string;
  url?: string;
  playing?: boolean;
  ready?: boolean;
  resume?: boolean;
  loop?: AudioLoop;
}

interface IOSAudioHandler {
  postMessage(message: unknown): Promise<NativePayload>;
}

const nativeBridge = (globalThis as { webkit?: { messageHandlers?: { musikeAudio?: IOSAudioHandler } } }).webkit?.messageHandlers
  ?.musikeAudio;

class Buffered {
  constructor(private to: number) {}
  get length() {
    return this.to > 0 ? 1 : 0;
  }
  end(_index: number) {
    return this.to;
  }
}

class NativeAudio extends EventTarget {
  // The player sets these; the native side only needs to know about them.
  private _volume = 1;
  private _muted = false;
  private _src = "";
  private _position = 0;
  private _duration = NaN;
  private _paused = true;
  private _ended = false;
  private _bufferedEnd = 0;
  /** Set while a seek is in flight: the native player keeps reporting the old position until it lands. */
  private _seekTarget: number | null = null;
  private _sourceId = 0;
  private _startAt = 0;
  private _playlist: NativePlaylist | null = null;
  private _semitones = 0;
  private _loop: AudioLoop = { from: null, to: null, on: false };

  private _rate = 1;
  private _preservePitch = true;

  readyState = 0;
  networkState = 0;
  error: { code: number; message: string } | null = null;
  preload = "auto";

  constructor(private bridge: Bridge, readonly independentPitch = false) {
    super();
    const host = globalThis as {
      __musikeAudioEvent?: (event: string, data: NativePayload) => void;
      __musikeAudioEl?: NativeAudio;
    };
    host.__musikeAudioEvent = (event, data) => this.fromNative(event, data ?? {});
    // Handy when something needs to poke the player from the console.
    host.__musikeAudioEl = this;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.reconcile();
    });
    globalThis.addEventListener("pageshow", () => this.reconcile());
  }

  get src() {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    this._ended = false;
    this.error = null;
    this.readyState = 0;
    this._bufferedEnd = 0;
    this._position = this._startAt;
    this._duration = NaN;
    this._seekTarget = null;
    this.bridge.postMessage({ cmd: "load", url: value, sourceId: ++this._sourceId, startAt: this._startAt, queue: this._playlist });
    this._startAt = 0;
    this.pushLoop();
  }

  get currentTime() {
    return this._position;
  }

  startAt(seconds: number) { this._startAt = Number.isFinite(seconds) ? Math.max(0, seconds) : 0; }

  playlist(queue: NativePlaylist) {
    this._playlist = queue;
    this.bridge.postMessage({ cmd: "queue", queue, sourceId: this._sourceId });
  }

  private reconcile() {
    void this.bridge.snapshot?.().then((data) => this.fromNative("snapshot", data)).catch(() => {});
  }

  set currentTime(value: number) {
    this._position = value;
    this._seekTarget = value;
    this.bridge.postMessage({ cmd: "seek", to: value, sourceId: this._sourceId });
  }

  cue(value: number) {
    this._position = value;
    this._seekTarget = value;
    this._paused = false;
    this._ended = false;
    this.bridge.postMessage({ cmd: "cue", to: value, sourceId: this._sourceId });
  }

  position(): Promise<number> {
    return this.bridge.position?.(this._sourceId) ?? Promise.resolve(this.currentTime);
  }

  loop(value: AudioLoop) {
    this._loop = value;
    this.pushLoop();
  }

  private pushLoop() {
    if (this.independentPitch) this.bridge.postMessage({ cmd: "loop", ...this._loop, sourceId: this._sourceId });
  }

  tune(semitones: number) {
    if (this._semitones === semitones) return;
    this._semitones = semitones;
    this.pushRate();
  }

  get duration() {
    return this._duration;
  }

  get paused() {
    return this._paused;
  }

  get ended() {
    return this._ended;
  }

  get seeking() {
    return this._seekTarget !== null;
  }

  get playbackRate() {
    return this._rate;
  }

  set playbackRate(value: number) {
    this._rate = value;
    this.pushRate();
  }

  /** Chrome/Safari: true keeps the pitch when the tempo changes (the app's "Speed" mode). */
  get preservesPitch() {
    return this._preservePitch;
  }

  set preservesPitch(value: boolean) {
    if (this._preservePitch === value) return;
    this._preservePitch = value;
    this.pushRate();
  }

  get webkitPreservesPitch() {
    return this._preservePitch;
  }

  set webkitPreservesPitch(value: boolean) {
    this.preservesPitch = value;
  }

  /** Sends speed, mode and independent tuning together to either native engine. */
  private pushRate() {
    this.bridge.postMessage({ cmd: "rate", value: this._rate, preservePitch: this._preservePitch, semitones: this._semitones });
  }

  get volume() {
    return this._volume;
  }

  set volume(value: number) {
    this._volume = value;
    this.bridge.postMessage({ cmd: "volume", value });
  }

  get muted() {
    return this._muted;
  }

  set muted(value: boolean) {
    this._muted = value;
    this.bridge.postMessage({ cmd: "muted", value });
  }

  get buffered() {
    return new Buffered(this._bufferedEnd);
  }

  getAttribute(name: string) {
    return name === "src" ? this._src : null;
  }

  setAttribute(name: string, value: string) {
    if (name === "src") this.src = value;
  }

  removeAttribute(name: string) {
    if (name !== "src") return;
    this._src = "";
    this._position = 0;
    this._seekTarget = null;
    this.bridge.postMessage({ cmd: "load", url: "", sourceId: ++this._sourceId });
  }

  load() {
    if (this._src) this.src = this._src;
  }

  play() {
    this._paused = false;
    this.bridge.postMessage({ cmd: "play" });
    return Promise.resolve();
  }

  pause() {
    this._paused = true;
    this.bridge.postMessage({ cmd: "pause" });
    this.dispatchEvent(new Event("pause"));
  }

  private fromNative(event: string, data: NativePayload) {
    if (data.sourceId != null && data.sourceId !== this._sourceId) return;
    switch (event) {
      case "track":
      case "snapshot": {
        if (data.trackId == null || data.queueIndex == null) break;
        this._src = data.url ?? this._src;
        this._position = data.position ?? 0;
        this._duration = data.duration ?? NaN;
        this._seekTarget = null;
        this._ended = false;
        this._paused = data.playing === false;
        this.readyState = data.ready ? 4 : 0;
        this._bufferedEnd = data.buffered ?? 0;
        this._loop = data.loop ?? { from: null, to: null, on: false };
        this.dispatchEvent(new CustomEvent("nativetrackchange", { detail: data }));
        if (data.ready) {
          this.dispatchEvent(new Event("loadedmetadata"));
          this.dispatchEvent(new Event(this._paused ? "pause" : "playing"));
        }
        break;
      }
      case "ready":
        this._duration = data.duration ?? NaN;
        this.readyState = 4;
        this.dispatchEvent(new Event("loadedmetadata"));
        this.dispatchEvent(new Event("durationchange"));
        break;
      case "time": {
        const position = data.position ?? this._position;
        if (data.duration && Number.isFinite(data.duration)) this._duration = data.duration;
        // Right after a seek the player reports no loaded ranges; keep the bar at least up to the playhead.
        const loaded = data.buffered ?? 0;
        if (loaded > 0) this._bufferedEnd = Math.max(loaded, position);
        // Ignore positions from before a pending seek; otherwise the player snaps back to where it was.
        if (this._seekTarget !== null && Math.abs(position - this._seekTarget) > 0.15) {
          this.dispatchEvent(new Event("progress"));
          break;
        }
        this._seekTarget = null;
        this._position = position;
        this._bufferedEnd = Math.max(this._bufferedEnd, position);
        this.dispatchEvent(new Event("timeupdate"));
        this.dispatchEvent(new Event("progress"));
        break;
      }
      case "seeked":
        if (this._seekTarget !== null && Math.abs((data.position ?? this._position) - this._seekTarget) > 0.15) break;
        this._seekTarget = null;
        this._position = data.position ?? this._position;
        this._bufferedEnd = Math.max(this._bufferedEnd, this._position);
        this.dispatchEvent(new Event("seeked"));
        this.dispatchEvent(new Event("timeupdate"));
        this.dispatchEvent(new Event("progress"));
        break;
      case "playing":
        this._paused = false;
        this.readyState = 4;
        this.dispatchEvent(new Event("playing"));
        break;
      case "pause":
        this._paused = true;
        this.dispatchEvent(new Event("pause"));
        break;
      case "ended":
        this._ended = true;
        this._paused = true;
        this.dispatchEvent(new Event("ended"));
        break;
      case "error":
        this.error = { code: 4, message: data.message ?? "Playback failed" };
        this.dispatchEvent(new Event("error"));
        break;
      default:
        break;
    }
  }
}

interface AndroidAudioPlugin {
  setSource(options: { url: string; sourceId: number; startAt: number; queue: NativePlaylist | null }): Promise<void>;
  setQueue(options: { sourceId: number; queue: NativePlaylist }): Promise<void>;
  snapshot(): Promise<NativePayload>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { to: number; sourceId: number }): Promise<void>;
  cue(options: { to: number; sourceId: number }): Promise<void>;
  position(options: { sourceId: number }): Promise<{ position: number }>;
  loop(options: AudioLoop & { sourceId: number }): Promise<void>;
  volume(options: { value: number }): Promise<void>;
  muted(options: { value: boolean }): Promise<void>;
  rate(options: { value: number; preservePitch: boolean; semitones: number }): Promise<void>;
  addListener(event: "event", fn: (e: { event: string } & NativePayload) => void): Promise<PluginListenerHandle>;
}

/** Turns the HTMLMediaElement calls into MusikeAudioPlugin commands (MusikeAudioPlugin.java). */
function androidBridge(plugin: AndroidAudioPlugin): Bridge {
  return {
    position: (sourceId) => plugin.position({ sourceId }).then((r) => r.position),
    snapshot: () => plugin.snapshot(),
    postMessage(message: unknown) {
      const { cmd, ...args } = message as { cmd: string } & Record<string, unknown>;
      const run = (promise: Promise<void>) => void promise.catch(() => {});
      switch (cmd) {
        case "load":
          run(plugin.setSource({ url: String(args.url ?? ""), sourceId: Number(args.sourceId), startAt: Number(args.startAt ?? 0), queue: args.queue as NativePlaylist | null }));
          break;
        case "queue":
          run(plugin.setQueue({ sourceId: Number(args.sourceId), queue: args.queue as NativePlaylist }));
          break;
        case "play":
          run(plugin.play());
          break;
        case "pause":
          run(plugin.pause());
          break;
        case "seek":
          run(plugin.seek({ to: Number(args.to ?? 0), sourceId: Number(args.sourceId) }));
          break;
        case "cue":
          run(plugin.cue({ to: Number(args.to ?? 0), sourceId: Number(args.sourceId) }));
          break;
        case "loop":
          run(plugin.loop({ from: Number(args.from ?? 0), to: Number(args.to ?? 0), on: Boolean(args.on), sourceId: Number(args.sourceId) }));
          break;
        case "volume":
          run(plugin.volume({ value: Number(args.value ?? 1) }));
          break;
        case "muted":
          run(plugin.muted({ value: Boolean(args.value) }));
          break;
        case "rate":
          run(plugin.rate({ value: Number(args.value ?? 1), preservePitch: args.preservePitch !== false, semitones: Number(args.semitones ?? 0) }));
          break;
        default:
          break;
      }
    },
  };
}

/** The audio element for this platform: native on iOS and Android, a real `<audio>` everywhere else. */
export function createAudio(): HTMLAudioElement {
  if (nativeBridge) {
    const bridge: Bridge = {
      postMessage: (message) => { void nativeBridge.postMessage(message).catch(() => {}); },
      position: (sourceId) => nativeBridge.postMessage({ cmd: "position", sourceId }).then((data) => {
        if (data.position == null || !Number.isFinite(data.position)) throw new Error("Invalid native playhead");
        return data.position;
      }),
      snapshot: () => nativeBridge.postMessage({ cmd: "snapshot" }),
    };
    return new NativeAudio(bridge, true) as unknown as HTMLAudioElement;
  }
  if (Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("MusikeAudio")) {
    const plugin = registerPlugin<AndroidAudioPlugin>("MusikeAudio");
    const audio = new NativeAudio(androidBridge(plugin), true);
    void plugin
      .addListener("event", ({ event, ...data }) => {
        (globalThis as { __musikeAudioEvent?: (event: string, data: NativePayload) => void }).__musikeAudioEvent?.(
          event,
          data as NativePayload,
        );
      })
      .catch(() => undefined);
    return audio as unknown as HTMLAudioElement;
  }
  const audio = new Audio();
  audio.preload = "auto";
  return audio;
}

export const supportsIndependentPitch = (media: HTMLMediaElement) =>
  media instanceof NativeAudio && media.independentPitch;

export function setAudioTuning(media: HTMLMediaElement, semitones: number) {
  if (media instanceof NativeAudio && media.independentPitch) media.tune(semitones);
}

/** Returns true when the native engine handled seeking and playback atomically. */
export function cueAudio(media: HTMLMediaElement, seconds: number): boolean {
  if (!(media instanceof NativeAudio) || !media.independentPitch) return false;
  media.cue(seconds);
  return true;
}

export function readAudioPosition(media: HTMLMediaElement): Promise<number> {
  return media instanceof NativeAudio ? media.position() : Promise.resolve(media.currentTime);
}

/** Preserve a cue/resume position through asynchronous native file preparation. */
export function setAudioStart(media: HTMLMediaElement, seconds: number) {
  if (media instanceof NativeAudio) media.startAt(seconds);
}

/** The full playlist is native-owned so track changes do not depend on a running WebView. */
export function setAudioPlaylist(media: HTMLMediaElement, queue: NativePlaylist) {
  if (media instanceof NativeAudio && media.independentPitch) media.playlist(queue);
}

/** Native loop timing stays off the throttled WebView event queue. */
export function setAudioLoop(media: HTMLMediaElement, loop: AudioLoop) {
  if (media instanceof NativeAudio && media.independentPitch) media.loop(loop);
}
