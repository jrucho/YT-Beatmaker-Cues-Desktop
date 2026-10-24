import type { MidiMessage } from "./midi";

export interface ControllerMapping {
  id: string;
  label: string;
  description?: string;
  padToNote: readonly number[];
  bankNoteMaps?: Readonly<Record<string, { channel: number; padToNote: readonly number[] }>>;
  /** User-facing channels (1–16); omitted mappings use the currently selected bank. */
  bankChannels?: Readonly<Record<string, number>>;
  ccStart?: number;
}

export const SP404MKII: ControllerMapping = {
  id: "sp404mkii-a",
  label: "SP-404MKII · MIDI Mode A",
  description: "Same Roland pad notes 36–51 on every bank · CH 1–10 → A–J",
  padToNote: [48, 49, 50, 51, 44, 45, 46, 47, 40, 41, 42, 43, 36, 37, 38, 39],
  bankChannels: { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10 },
  ccStart: 20,
};
export const SP404MKII_B: ControllerMapping = {
  id: "sp404mkii-b", label: "SP-404MKII · MIDI Mode B",
  description: "Roland Mode B · CH 1: A–E · CH 2: F–J · bank-specific note ranges (default channel settings)",
  padToNote: SP404MKII.padToNote,
  bankNoteMaps: Object.fromEntries("ABCDEFGHIJ".split("").map((bank, i) => {
    const base = 12 + (i % 5) * 16;
    return [bank, { channel: i < 5 ? 1 : 2, padToNote: SP404MKII.padToNote.map(note => base + note - 36) }];
  })),
};
export const LEGACY12: ControllerMapping = {
  id: "legacy12", label: "Legacy · 12 pads (notes 36–47)",
  padToNote: Array.from({ length: 12 }, (_, i) => i + 36), ccStart: 20,
};
export const CONTROLLER_PRESETS = [SP404MKII, SP404MKII_B, LEGACY12];
const KEY = "musike:midi:preset";
export function readControllerPreset(): ControllerMapping {
  try { return CONTROLLER_PRESETS.find(p => p.id === localStorage.getItem(KEY)) ?? SP404MKII; }
  catch { return SP404MKII; }
}
export function saveControllerPreset(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* storage unavailable */ }
}

/** Native and Web MIDI decoders both supply zero-based channel numbers. */
export function mapControllerMessage(message: MidiMessage, mapping: ControllerMapping, currentBank: string) {
  if (!Number.isInteger(message.channel) || message.channel < 0 || message.channel > 15) return null;
  if (mapping.bankNoteMaps) {
    // Note ranges identify banks in Mode B; CCs cannot unambiguously select them.
    if (message.type === "cc") return null;
    for (const [bank, target] of Object.entries(mapping.bankNoteMaps)) {
      if (target.channel !== message.channel + 1) continue;
      const index = target.padToNote.indexOf(message.note ?? -1);
      if (index < 0) continue;
      const velocity = Math.max(0, Math.min(127, message.velocity ?? 0));
      return { bank, pad: index + 1, velocity, pressed: message.type === "noteon" && velocity > 0 };
    }
    return null;
  }
  const bank = mapping.bankChannels
    ? Object.keys(mapping.bankChannels).find(bank => mapping.bankChannels![bank] === message.channel + 1)
    : currentBank;
  if (!bank) return null;
  const cc = message.type === "cc";
  const index = cc
    ? mapping.ccStart == null ? -1 : (message.controller ?? -1) - mapping.ccStart
    : mapping.padToNote.indexOf(message.note ?? -1);
  if (index < 0 || index >= mapping.padToNote.length) return null;
  const velocity = Math.max(0, Math.min(127, (cc ? message.value : message.velocity) ?? 0));
  return { bank, pad: index + 1, velocity, pressed: message.type !== "noteoff" && velocity > 0 };
}
