import { create } from "zustand";

export const CUE_BANKS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export const CUE_PAD_COUNT = 12;

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

interface CueState {
  trackId: string | null;
  bank: string;
  cues: BankCues;
  setTrack: (trackId: string | null) => void;
  setBank: (bank: string) => void;
  setCue: (pad: number, seconds: number) => void;
  setNextCue: (seconds: number) => void;
  clearCue: (pad: number) => void;
  clearBank: () => void;
}

export const useCueStore = create<CueState>((set, get) => ({
  trackId: null,
  bank: "A",
  cues: {},

  setTrack: (trackId) => {
    if (get().trackId === trackId) return;
    set({ trackId, cues: bankCues(trackId, get().bank) });
  },

  setBank: (bank) => set({ bank, cues: bankCues(get().trackId, bank) }),

  setCue: (pad, seconds) => {
    const { trackId, bank, cues } = get();
    if (!trackId || pad < 1 || pad > CUE_PAD_COUNT) return;
    const next = { ...cues, [pad]: Math.max(0, seconds) };
    const all = readAll();
    all[trackId] = { ...all[trackId], [bank]: next };
    writeAll(all);
    set({ cues: next });
  },

  setNextCue: (seconds) => {
    if (!Number.isFinite(seconds)) return;
    const { cues } = get();
    for (let pad = 1; pad <= CUE_PAD_COUNT; pad++) {
      if (cues[pad] == null) {
        get().setCue(pad, seconds);
        return;
      }
    }
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
