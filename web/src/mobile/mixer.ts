import { create } from 'zustand';
import { mediaInvoke } from './mediaEditing';
import { editGestureToken, recordEdit } from './editHistory';

export interface MixerState {enabled:boolean;song:number;samples:number;output:number}
export const DEFAULT_MIXER:MixerState={enabled:false,song:1,samples:1,output:1.5};
export const useMixer=create<MixerState>(()=>({...DEFAULT_MIXER}));
async function apply(value:MixerState){const next=await mediaInvoke<MixerState>('mixer',value);useMixer.setState(next);localStorage.setItem('musike:mixer',JSON.stringify(next));window.dispatchEvent(new Event('plugin-preferences-changed'));}
export async function refreshMixer(){useMixer.setState(await mediaInvoke<MixerState>('mixer'));}
let changes:Promise<unknown>=Promise.resolve();
export function changeMixer(patch:Partial<MixerState>){
  const gesture=editGestureToken('mixer');
  const work=changes.catch(()=>{}).then(async()=>{
    const current=useMixer.getState(),before={enabled:current.enabled,song:current.song,samples:current.samples,output:current.output},after={...before,...patch};
    await apply(after);if(JSON.stringify(before)!==JSON.stringify(after))recordEdit({label:'mixer',key:'mixer',undo:()=>apply(before),redo:()=>apply(after)},gesture);
  });changes=work;return work;
}
