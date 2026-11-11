import { create } from "zustand";
import { recordEdit } from "./editHistory";

export interface PadSample { bank: string; pad: number; name: string; duration: number; ready: boolean; error?: string; path?: string; start?: number; peaks?: number[] }
export interface PadPermutation { bank: string; pads: number[] }
const invoke = (name: string, ...args: unknown[]): Promise<any> => (window as any).__pluginInvoke(name, ...args);
export const padSamplesAvailable = () => typeof (window as any).__pluginInvoke === "function";
export const usePadSamples = create<{ samples: Record<string, PadSample>; update(pads: PadSample[]): void }>((set) => ({
  samples: {},
  update: pads => { if (Array.isArray(pads)) set({ samples: Object.fromEntries(pads.map(pad => [`${pad.bank}:${pad.pad}`, pad])) }); },
}));
export const hasPadSample = (bank: string, pad: number) => !!usePadSamples.getState().samples[`${bank}:${pad}`];
export const refreshPadSamples = async () => { if (padSamplesAvailable()) usePadSamples.getState().update(await invoke("padSamples")); };
export async function remapPadSamples(mappings: PadPermutation[]) { usePadSamples.getState().update(await invoke('remapPadSamples',mappings)); }
export async function changePadSample(cmd: "load" | "remove", bank: string, pad: number) {
  const before = usePadSamples.getState().samples[`${bank}:${pad}`];
  usePadSamples.getState().update(await invoke("padSample", { cmd, bank, pad }));
  const after = usePadSamples.getState().samples[`${bank}:${pad}`];
  if (JSON.stringify(before) !== JSON.stringify(after)) recordEdit({ label: `${cmd==='load'?'load':'remove'} sample ${bank}${pad}`,
    undo: () => restoreSample(bank, pad, before), redo: () => restoreSample(bank, pad, after) });
}
async function restoreSample(bank: string, pad: number, descriptor?: PadSample) {
  usePadSamples.getState().update(await invoke('padSample', { cmd: 'restore', bank, pad, descriptor: descriptor ?? null }));
}
export async function setPadSampleStart(bank: string, pad: number, start: number) {
  const before=usePadSamples.getState().samples[`${bank}:${pad}`]?.start ?? 0;
  const apply=async(value:number)=>{usePadSamples.getState().update(await invoke('padSample',{cmd:'start',bank,pad,start:value}));};
  await apply(start);
  const after=usePadSamples.getState().samples[`${bank}:${pad}`]?.start ?? 0;
  if(before!==after)recordEdit({label:`sample start ${bank}${pad}`,undo:()=>apply(before),redo:()=>apply(after)});
}
export function playPadSample(bank: string, pad: number) { return invoke("padSample", { cmd: "trigger", bank, pad }); }
