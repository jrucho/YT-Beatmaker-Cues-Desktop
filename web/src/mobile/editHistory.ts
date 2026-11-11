import { create } from "zustand";
import { iosPadLayoutEnabled } from "./padLayout";

export interface Edit { label: string; undo(): void | Promise<void>; redo(): void | Promise<void>; key?: string }
interface History { past: Edit[]; future: Edit[]; busy: boolean; undo(): Promise<void>; redo(): Promise<void> }
let gesture: { key: string; token: string } | null = null;
let gestureSerial = 0;
export const beginEditGesture = (key: string) => { gesture = { key, token: `${key}:${++gestureSerial}` }; };
export const endEditGesture = () => { gesture = null; };
export const editGestureToken = (key: string) => gesture?.key === key ? gesture.token : null;

export const useEditHistory = create<History>((set, get) => ({
  past: [], future: [], busy: false,
  undo: async () => {
    const { past, future, busy } = get(); if (busy || !past.length) return;
    const edit = past[past.length - 1]; set({ busy: true });
    try { await edit.undo(); set({ past: past.slice(0, -1), future: [...future, edit] }); }
    finally { set({ busy: false }); }
  },
  redo: async () => {
    const { past, future, busy } = get(); if (busy || !future.length) return;
    const edit = future[future.length - 1]; set({ busy: true });
    try { await edit.redo(); set({ past: [...past, edit], future: future.slice(0, -1) }); }
    finally { set({ busy: false }); }
  },
}));

export function recordEdit(edit: Edit, gestureToken?: string | null) {
  if (!iosPadLayoutEnabled() || useEditHistory.getState().busy) return;
  useEditHistory.setState(state => {
    const previous = state.past[state.past.length - 1];
    const token = gestureToken === undefined ? (gesture && edit.key === gesture.key ? gesture.token : undefined) : gestureToken ?? undefined;
    const sameGesture = token && previous?.key === token;
    const entry = sameGesture ? { ...edit, key: token, undo: previous.undo } : { ...edit, key: token };
    return { past: [...(sameGesture ? state.past.slice(0, -1) : state.past), entry].slice(-80), future: [] };
  });
}

export function recordStorageEdit(label: string, key: string, before: string | null, after: string | null) {
  if (before === after) return;
  const apply = (value: string | null) => {
    if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    window.dispatchEvent(new Event("plugin-preferences-changed"));
  };
  recordEdit({ label, key, undo: () => apply(before), redo: () => apply(after) });
}

if (typeof window !== "undefined") {
  window.addEventListener("plugin-record-edit", event => recordEdit((event as CustomEvent<Edit>).detail));
  window.addEventListener("keydown", event => {
    if (!iosPadLayoutEnabled() || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    void (event.shiftKey ? useEditHistory.getState().redo() : useEditHistory.getState().undo()).catch(console.error);
  });
}
