import { useEffect } from 'react';
import { create } from 'zustand';
import { mediaInvoke } from './mediaEditing';
import { recordEdit, useEditHistory } from './editHistory';

export interface PadLoop {bank:string;pad:number;mode:0|1|2|3;duration:number;length:number;layers:number;undone:boolean;count:number;events?:number[]}
interface Snapshot {song:string;revision:number;generation:number;pads:PadLoop[]}
export const usePadLoopers=create<{song:string;pads:Record<string,PadLoop>;revision:number}>(()=>({song:'',pads:{},revision:0}));
export const hasPadLooper=(bank:string,pad:number,trackId:string|null)=>usePadLoopers.getState().song===(trackId??'@empty')&&!!usePadLoopers.getState().pads[`${bank}:${pad}`];
const musical=(snapshot:Snapshot)=>JSON.stringify(snapshot.pads.map(({bank,pad,length,layers,undone,events})=>({bank,pad,length,layers,undone,events})).sort((a,b)=>a.bank.localeCompare(b.bank)||a.pad-b.pad));
let previous:Snapshot|undefined;const baselines=new Map<string,Snapshot>();
let suppressed=0;
export async function withoutLooperHistory<T>(work:()=>Promise<T>){suppressed++;try{return await work();}finally{try{await refreshLoopers();}finally{suppressed--;}}}
async function restore(snapshot:Snapshot){await mediaInvoke('looperPad',{cmd:'restore',data:snapshot});previous=undefined;await refreshLoopers();}
export async function refreshLoopers(){
  const next=await mediaInvoke<Snapshot>('looperState',{events:true});if(!next||!Array.isArray(next.pads))return;
  const before=previous;
  if(before?.song===next.song&&!useEditHistory.getState().busy&&!suppressed){
    for(const pad of next.pads){const key=`${pad.bank}:${pad.pad}`,old=before.pads.find(value=>value.bank===pad.bank&&value.pad===pad.pad),editing=pad.mode===1||pad.mode===3,wasEditing=old?.mode===1||old?.mode===3;
      if(editing&&!wasEditing)baselines.set(key,before);
      if(!editing&&wasEditing){const baseline=baselines.get(key)??before;baselines.delete(key);if(musical(baseline)!==musical(next))recordEdit({label:`looper ${key}`,undo:()=>restore(baseline),redo:()=>restore(next)});}
    }
    const editing=next.pads.some(pad=>pad.mode===1||pad.mode===3)||before.pads.some(pad=>pad.mode===1||pad.mode===3);
    if(!editing&&musical(before)!==musical(next))recordEdit({label:'looper edit',undo:()=>restore(before),redo:()=>restore(next)});
  }else if(before?.song!==next.song)baselines.clear();
  previous=next;usePadLoopers.setState({song:next.song,revision:next.revision,pads:Object.fromEntries(next.pads.map(pad=>[`${pad.bank}:${pad.pad}`,pad]))});return next;
}
export function pressLooper(bank:string,pad:number){return mediaInvoke('looperPad',{cmd:'press',bank,pad});}
export function releaseLooper(bank:string,pad:number){return mediaInvoke('looperPad',{cmd:'release',bank,pad});}
export async function changeLooper(bank:string,pad:number,enabled:boolean){await mediaInvoke('looperPad',{cmd:enabled?'assign':'remove',bank,pad});for(let i=0;i<100;i++){await refreshLoopers();if(!!usePadLoopers.getState().pads[`${bank}:${pad}`]===enabled)return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Looper edit did not complete');}
export function useLooperStatus(enabled:boolean){useEffect(()=>{if(!enabled)return;let busy=false,closed=false;const poll=async()=>{if(busy||closed)return;busy=true;try{await refreshLoopers();}catch{}finally{busy=false;}};void poll();const timer=setInterval(poll,120);return()=>{closed=true;clearInterval(timer);};},[enabled]);}
