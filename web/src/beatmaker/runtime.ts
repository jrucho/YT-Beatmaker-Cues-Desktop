import { beatmakerMedia, selectCurrent, usePlayer } from "../player/player";
import { mapControllerMessage, readControllerPreset } from "../native/controllerMapping";

export interface Engine {
  snapshot(): { cues: Record<string, number>; pitch: number; ready: boolean; mediaReady: boolean; rateMode: string; rateTarget: string; rateMin: number; rateMax: number; saved: boolean };
  cue(key: string, overwrite?: boolean): void;
  remove(key: string): void;
  bank(): void;
  random(): void;
  pitch(value: number): void;
  advanced(): void;
  sequencer(): void;
  sidechain(): void;
  fx(): void;
  vj(): void;
  mini(): void;
  mapping(): void;
}
declare global {
  interface Window {
    musikeBeatmakerEngine?: Engine;
    musikeBeatmakerHost?: { active: boolean; media: typeof beatmakerMedia; trackId(): string; cueId(): string; bankName(): string; midi?(data: ArrayLike<number>): boolean; midiOverwrite?: boolean };
  }
}

let currentBank = "A";
export function setEngineBank(bank: string) {
  currentBank = bank;
  window.musikeBeatmakerEngine?.bank();
}
type Message = Record<string, any>;
type Listener = (message: Message, sender: Message, respond: (response: any) => void) => boolean | void;
function event<T>() {
  const listeners = new Set<T>();
  return { addListener: (fn: T) => listeners.add(fn), removeListener: (fn: T) => listeners.delete(fn), listeners };
}
let loading: Promise<void> | undefined;
const base = "/beatmaker/";
function script(file: string) {
  return new Promise<void>((resolve, reject) => {
    const el = Object.assign(document.createElement("script"), { src: base + file });
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Could not load Beatmaker: ${file}`));
    document.head.appendChild(el);
  });
}

// A local replacement for extension storage/messaging. All DSP runs in the app;
// there is no extension installation, remote page injection, or second player.
export function loadBeatmaker() {
  return loading ??= (async () => {
    const mediaHost = Object.assign(document.createElement("div"), { hidden: true, id: "bm-media-host" });
    document.body.appendChild(mediaHost);
    window.musikeBeatmakerHost = {
      active: true,
      media: () => {
        const media = beatmakerMedia();
        if (!media.parentNode) mediaHost.appendChild(media);
        return media;
      },
      trackId: () => {
        const media = beatmakerMedia();
        const id = new URL(media.src || location.href, location.href).pathname.match(/^\/api\/stream\/([\w-]{11})\//)?.[1]
          ?? selectCurrent(usePlayer.getState())?.id;
        return id ? `youtube:${id}` : "none";
      },
      cueId: () => `${selectCurrent(usePlayer.getState())?.id ?? "none"}:bank:${currentBank}`,
      bankName: () => currentBank,
      midi: data => {
        if (!window.musikeBeatmakerHost?.active || data.length < 3) return false;
        const kind = data[0] & 0xf0;
        if (![0x80, 0x90, 0xb0].includes(kind)) return false;
        const target = mapControllerMessage({ type: kind === 0xb0 ? "cc" : kind === 0x80 ? "noteoff" : "noteon",
          channel: data[0] & 15, note: data[1], controller: data[1], velocity: data[2], value: data[2] }, readControllerPreset(), currentBank);
        if (!target) return false;
        if (target.pressed) {
          if (target.bank !== currentBank) {
            setEngineBank(target.bank);
            window.dispatchEvent(new CustomEvent("beatmaker-bank", { detail: target.bank }));
          }
          const key = target.pad === 10 ? "0" : String(target.pad);
          try { window.musikeBeatmakerEngine?.cue(key, window.musikeBeatmakerHost.midiOverwrite); }
          catch (error) { window.dispatchEvent(new CustomEvent("beatmaker-error", { detail: (error as Error).message })); }
        }
        window.dispatchEvent(new CustomEvent("beatmaker-midi-pad", { detail: target }));
        return true;
      },
    };
    const onChanged = event<(changes: Message, area: string) => void>();
    function storage(prefix: string) {
      const read = () => JSON.parse(localStorage.getItem(prefix) ?? "{}");
      const finish = <T,>(value: T, cb?: (v: T) => void) => { cb?.(value); return Promise.resolve(value); };
      return {
        get(keys?: string | string[] | Message | null, cb?: (v: Message) => void) {
          const all = read();
          const result = !keys ? all : Object.fromEntries((typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)).map(k => [k, all[k] ?? (typeof keys === "object" && !Array.isArray(keys) ? keys[k] : undefined)]));
          return finish(result, cb);
        },
        set(values: Message, cb?: () => void) {
          const all = read();
          localStorage.setItem(prefix, JSON.stringify({ ...all, ...values }));
          onChanged.listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { oldValue: all[k], newValue: v }])), "local"));
          return finish(undefined, cb);
        },
        remove(keys: string | string[], cb?: () => void) {
          const all = read();
          for (const key of typeof keys === "string" ? [keys] : keys) delete all[key];
          localStorage.setItem(prefix, JSON.stringify(all));
          return finish(undefined, cb);
        },
      };
    }
    const onMessage = event<Listener>();
    const sender = { id: "musike-beatmaker", tab: { id: 1 }, frameId: 0, documentId: "musike" };
    function dispatch(msg: Message) {
      return new Promise<any>((resolve, reject) => {
        let answered = false, pending = false;
        const timeout = setTimeout(() => reject(new Error("Beatmaker engine request timed out")), 120_000);
        const respond = (result: any) => { if (!answered) { answered = true; clearTimeout(timeout); resolve(result); } };
        for (const fn of onMessage.listeners) {
          try { if (fn(msg, sender, respond) === true) pending = true; }
          catch (err) { clearTimeout(timeout); reject(err); return; }
        }
        if (!pending && !answered) respond({ ok: true });
      });
    }
    let tabId = "musike";
    async function send(msg: Message): Promise<any> {
      if (msg.target === "ytbm-stems-background") return dispatch({ ...msg, target: "ytbm-stems" });
      if (msg.type === "ytbm-register-tab") { tabId = msg.ytbmTabId; return { ok: true, order: [tabId] }; }
      if (msg.type === "ytbm-get-tab-order") return { ok: true, order: [tabId] };
      if (msg.type === "ytbm-vj-performance") return { ok: true };
      if (msg.type === "ytbm-fetch-asset") {
        const path = String(msg.path).replace(/^\/+/, "");
        if (path.includes("..")) throw new Error("Invalid asset path");
        const response = await fetch(base + path);
        if (!response.ok) throw new Error(`Asset unavailable: ${path}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { ok: true, dataB64: btoa(binary), byteLength: bytes.length };
      }
      if (msg.type?.startsWith("ytbm-stems-")) {
        const track = selectCurrent(usePlayer.getState());
        const media = beatmakerMedia();
        const sourceId = window.musikeBeatmakerHost!.trackId().replace(/^youtube:/, "");
        const sourceInfo = msg.type === "ytbm-stems-track-preload" && track ? {
          sources: [new URL(`/api/stream/${sourceId}/audio`, location.origin).href], duration: Number.isFinite(media.duration) ? media.duration : track.duration, videoId: sourceId, title: track.title,
        } : undefined;
        return dispatch({ ...msg, sourceInfo, target: "ytbm-stems-host", tabId: 1, frameId: 0, documentId: "musike" });
      }
      return dispatch(msg);
    }
    const chrome = {
      storage: { local: storage("musike:beatmaker:storage"), session: storage("musike:beatmaker:session"), onChanged },
      runtime: {
        id: sender.id, getManifest: () => ({ version: "2.4.5", name: "Musike Beatmaker" }),
        getURL: (file: string) => new URL(base + file.replace(/^\/+/, ""), location.origin).href,
        onMessage,
        sendMessage(msg: Message, callback?: (result: any) => void) {
          const promise = send(msg).catch(error => ({ ok: false, error: (error as Error).message }));
          if (callback) void promise.then(callback);
          return promise;
        },
        connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: event(), onMessage: event() }),
      },
    };
    Object.assign((window as unknown as { chrome: Message }).chrome ??= {}, chrome);
    document.body.classList.add("beatmaker-host");
    document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: base + "style.css" }));
    for (const file of [
      "vj-live.js", "ui-tooltips.js", "player-cues-button.js", "video-region-loop.js",
      "addons/stems/model-store.js", "addons/stems/resource-storage.js", "addons/stems/session-downloads.js",
      "addons/stems/stem-timeline.js", "addons/stems/prepared-stretch.js", "addons/stems/track-store.js",
      "addons/stems/buffered-audio.js", "addons/stems/inference-host.js", "addons/stems/offscreen.js", "content.js",
    ]) await script(file);
    if (!window.musikeBeatmakerEngine) throw new Error("Beatmaker engine did not initialize");
    for (let i = 0; i < 100 && !window.musikeBeatmakerEngine.snapshot().ready; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!window.musikeBeatmakerEngine.snapshot().ready) throw new Error("Beatmaker controls could not initialize. Reload the app to retry.");
  })();
}
