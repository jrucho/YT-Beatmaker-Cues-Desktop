import {useSyncExternalStore} from 'react';
import {recordStorageEdit} from './editHistory';

const KEY='musike:transitions';
const clean=(value:any)=>({enabled:value?.enabled!==false,seconds:typeof value?.seconds==='number'&&Number.isFinite(value.seconds)?Math.max(.05,Math.min(2,value.seconds)):.35});
const read=()=>{try{return localStorage.getItem(KEY);}catch{return null;}};
const parse=(value:string|null)=>{try{return clean(JSON.parse(value||'{}'));}catch{return clean(null);}};
const subscribe=(listener:()=>void)=>{window.addEventListener('plugin-preferences-changed',listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener('plugin-preferences-changed',listener);window.removeEventListener('storage',listener);};};
export const useSongTransitions=()=>parse(useSyncExternalStore(subscribe,read,()=>null));
export function saveSongTransitions(patch:Partial<ReturnType<typeof clean>>){
  const before=read(),next=clean({...parse(before),...patch}),after=JSON.stringify(next);localStorage.setItem(KEY,after);
  recordStorageEdit('song fades',KEY,before,after);window.dispatchEvent(new Event('plugin-preferences-changed'));
}
