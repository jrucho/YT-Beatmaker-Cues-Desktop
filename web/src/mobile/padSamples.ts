import { create } from "zustand";

export interface PadSample { bank: string; pad: number; name: string; duration: number; ready: boolean; error?: string }
const invoke = (name: string, ...args: unknown[]): Promise<any> => (window as any).__pluginInvoke(name, ...args);
export const padSamplesAvailable = () => typeof (window as any).__pluginInvoke === "function";
export const usePadSamples = create<{ samples: Record<string, PadSample>; update(pads: PadSample[]): void }>((set) => ({
  samples: {},
  update: pads => { if (Array.isArray(pads)) set({ samples: Object.fromEntries(pads.map(pad => [`${pad.bank}:${pad.pad}`, pad])) }); },
}));
export const hasPadSample = (bank: string, pad: number) => !!usePadSamples.getState().samples[`${bank}:${pad}`];
export const refreshPadSamples = async () => { if (padSamplesAvailable()) usePadSamples.getState().update(await invoke("padSamples")); };
export async function changePadSample(cmd: "load" | "remove", bank: string, pad: number) {
  usePadSamples.getState().update(await invoke("padSample", { cmd, bank, pad }));
}
export function playPadSample(bank: string, pad: number) { return invoke("padSample", { cmd: "trigger", bank, pad }); }
