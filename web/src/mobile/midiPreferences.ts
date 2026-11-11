export type BankButtonMode = "separate" | "paired";
import { recordStorageEdit } from './editHistory';
const VELOCITY_KEY = "musike:midi:velocity";
const BANK_BUTTON_KEY = "musike:midi:bank-buttons";
export const BANK_PAIRS = [["A","F"],["B","G"],["C","H"],["D","I"],["E","J"]] as const;

function save(key: string, value: string) {
  try {
    const before=localStorage.getItem(key);
    localStorage.setItem(key, value);
    recordStorageEdit(key===VELOCITY_KEY?'MIDI velocity':'bank layout',key,before,value);
    window.dispatchEvent(new Event("plugin-preferences-changed"));
  } catch { /* storage unavailable */ }
}
export function readMidiVelocity() {
  try { return localStorage.getItem(VELOCITY_KEY) !== "off"; } catch { return true; }
}
export const saveMidiVelocity = (enabled: boolean) => save(VELOCITY_KEY, enabled ? "on" : "off");
export function readBankButtonMode(): BankButtonMode {
  try { return localStorage.getItem(BANK_BUTTON_KEY) === "paired" ? "paired" : "separate"; }
  catch { return "separate"; }
}
export const saveBankButtonMode = (mode: BankButtonMode) => save(BANK_BUTTON_KEY, mode);
export const nextPairedBank = (current: string, first: string, second: string) => current === first ? second : first;
