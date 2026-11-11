import type { ControllerMapping } from "../native/controllerMapping";
import { recordStorageEdit } from "./editHistory";

export type PadOrder = "top-left" | "bottom-left";
const KEY = "musike:midi:pad-order";
declare global { interface Window { __pluginIOSPreview?: boolean; __pluginFeatures?:boolean; __pluginPlatform?:'ios'|'android'|'desktop' } }

export const performanceFeaturesEnabled = () => typeof window !== "undefined" && (window.__pluginFeatures === true || window.__pluginIOSPreview === true);
/** Compatibility name for the original iOS-first feature gate. */
export const iosPadLayoutEnabled = performanceFeaturesEnabled;
export const nativePlatform=()=>window.__pluginPlatform??'ios';
export const supportsPadOrder = (preset: string) => preset === "linear16" || preset === "legacy12";

export function readPadOrder(preset: string): PadOrder {
  if (!supportsPadOrder(preset)) return "top-left";
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}")[preset] === "bottom-left" ? "bottom-left" : "top-left"; }
  catch { return "top-left"; }
}

export function savePadOrder(preset: string, order: PadOrder) {
  if (!supportsPadOrder(preset)) return;
  const saved = { linear16: readPadOrder("linear16"), legacy12: readPadOrder("legacy12"), [preset]: order };
  try {
    const before = localStorage.getItem(KEY);
    localStorage.setItem(KEY, JSON.stringify(saved));
    recordStorageEdit('pad numbering', KEY, before, JSON.stringify(saved));
    window.dispatchEvent(new Event("plugin-preferences-changed"));
  } catch { /* storage unavailable */ }
}

const ARRANGEMENTS = 'musike:pad-arrangements';
function readArrangements(): Record<string, number[]> {
  try { const value=JSON.parse(localStorage.getItem(ARRANGEMENTS) ?? '{}');return value&&typeof value==='object'?value:{}; } catch { return {}; }
}
export function padArrangement(preset: string, bank: string, count: number): number[] {
  const value=readArrangements()[`${preset}:${bank}`];
  return Array.isArray(value)&&value.length===count&&new Set(value).size===count&&value.every(pad=>Number.isInteger(pad)&&pad>=1&&pad<=count)?value:Array.from({length:count},(_,i)=>i+1);
}
export function savePadArrangement(preset: string, bank: string, pads: number[]) {
  const before=localStorage.getItem(ARRANGEMENTS),saved={...readArrangements(),[`${preset}:${bank}`]:pads};
  localStorage.setItem(ARRANGEMENTS,JSON.stringify(saved));
  recordStorageEdit(`arrange bank ${bank}`,ARRANGEMENTS,before,JSON.stringify(saved));
  window.dispatchEvent(new Event('plugin-preferences-changed'));
}

/** CSS order changes placement while preserving logical pad/MIDI/receipt IDs. */
export function padVisualOrder(mapping: ControllerMapping, pad: number, order: PadOrder, gridColumns?: number) {
  const index = pad - 1;
  if (!supportsPadOrder(mapping.id) || order !== "bottom-left") return index;
  const columns = gridColumns ?? (mapping.id === "legacy12" ? 3 : 4);
  const row = Math.floor(index / columns);
  return (mapping.padToNote.length / columns - 1 - row) * columns + index % columns;
}
