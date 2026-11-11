import { useSyncExternalStore } from 'react';
import { recordStorageEdit } from './editHistory';

const KEY='musike:waveform:drag-audition';
export function readAlwaysAudition() {try{return localStorage.getItem(KEY)==='always';}catch{return false;}}
export function saveAlwaysAudition(enabled:boolean) {
  const before=localStorage.getItem(KEY),after=enabled?'always':'held';localStorage.setItem(KEY,after);
  recordStorageEdit('zoomed waveform audition',KEY,before,after);
  window.dispatchEvent(new Event('plugin-preferences-changed'));
}
const subscribe=(listener:()=>void)=>{window.addEventListener('plugin-preferences-changed',listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener('plugin-preferences-changed',listener);window.removeEventListener('storage',listener);};};
export const useAlwaysAudition=()=>useSyncExternalStore(subscribe,readAlwaysAudition,()=>false);
