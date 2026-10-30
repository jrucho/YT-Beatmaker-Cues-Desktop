import { create } from "zustand";
import { readControllerPreset } from "../native/controllerMapping";
import { hasPadSample } from "./padSamples";

export const CUE_BANKS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export const CUE_PAD_COUNT = 16;

type BankCues = Record<number, number>;
type TrackCues = Record<string, BankCues>;
type AllCues = Record<string, TrackCues>;

const STORAGE_KEY = "musike:cues:v1";

function readAll(): AllCues {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as AllCues;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeAll(all: AllCues) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked */
  }
}

function bankCues(trackId: string | null, bank: string): BankCues {
  if (!trackId) return {};
  return readAll()[trackId]?.[bank] ?? {};
}

function initialBank(): string {
  try { const bank = localStorage.getItem("musike:cue-bank"); return bank && CUE_BANKS.includes(bank as typeof CUE_BANKS[number]) ? bank : "A"; }
  catch { return "A"; }
}

interface CueState {
  trackId: string | null;
  bank: string;
  cues: BankCues;
  setTrack: (trackId: string | null) => void;
  setBank: (bank: string) => void;
  setCue: (pad: number, seconds: number, targetBank?: string) => void;
  setNextCue: (seconds: number) => void;
  nextSlot: () => { bank: string; pad: number } | null;
  clearCue: (pad: number) => void;
  clearBank: () => void;
}

export const useCueStore = create<CueState>((set, get) => ({
  trackId: null,
  bank: initialBank(),
  cues: {},

  setTrack: (trackId) => {
    if (get().trackId === trackId) return;
    set({ trackId, cues: bankCues(trackId, get().bank) });
  },

  setBank: (bank) => {
    if (!CUE_BANKS.includes(bank as typeof CUE_BANKS[number])) return;
    try { localStorage.setItem("musike:cue-bank", bank); } catch {}
    set({ bank, cues: bankCues(get().trackId, bank) });
  },

  setCue: (pad, seconds, targetBank) => {
    const { trackId } = get();
    const bank = targetBank ?? get().bank;
    if (hasPadSample(bank, pad)) return;
    const cues = bank === get().bank ? get().cues : bankCues(trackId, bank);
    if (!trackId || !Number.isFinite(seconds) || !Number.isInteger(pad) || pad < 1 || pad > CUE_PAD_COUNT) return;
    const next = { ...cues, [pad]: Math.max(0, seconds) };
    const all = readAll();
    all[trackId] = { ...all[trackId], [bank]: next };
    writeAll(all);
    if (bank === get().bank) set({ cues: next });
  },

  nextSlot: () => {
    const { trackId, bank } = get();
    if (!trackId) return null;
    const all = readAll()[trackId] ?? {};
    for (const candidate of CUE_BANKS.slice(Math.max(0, CUE_BANKS.indexOf(bank as typeof CUE_BANKS[number])))) {
      const cues = candidate === bank ? get().cues : all[candidate] ?? {};
      for (let pad = 1; pad <= readControllerPreset().padToNote.length; pad++) {
        if (cues[pad] == null && !hasPadSample(candidate, pad)) return { bank: candidate, pad };
      }
    }
    return null;
  },

  setNextCue: (seconds) => {
    if (!Number.isFinite(seconds)) return;
    const slot = get().nextSlot();
    if (!slot) return;
    if (slot.bank !== get().bank) get().setBank(slot.bank);
    get().setCue(slot.pad, seconds);
  },

  clearCue: (pad) => {
    const { trackId, bank, cues } = get();
    if (!trackId) return;
    const next = { ...cues };
    delete next[pad];
    const all = readAll();
    if (all[trackId]) {
      all[trackId][bank] = next;
      if (!Object.keys(next).length) delete all[trackId][bank];
      if (!Object.keys(all[trackId]).length) delete all[trackId];
    }
    writeAll(all);
    set({ cues: next });
  },

  clearBank: () => {
    const { trackId, bank } = get();
    if (!trackId) return;
    const all = readAll();
    if (all[trackId]) {
      delete all[trackId][bank];
      if (!Object.keys(all[trackId]).length) delete all[trackId];
    }
    writeAll(all);
    set({ cues: {} });
  },
}));
