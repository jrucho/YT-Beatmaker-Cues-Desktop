import { useEffect, useSyncExternalStore } from 'react';
import type { Track } from '../lib/types';
import { useCueStore } from './cueStore';
import { usePadSamples, type PadSample } from './padSamples';

export interface WaveformSource { trackId?: string; sample?: boolean; bank: string; pad: number; path?: string; duration: number; peaks?: number[] }
interface Peaks { peaks: number[]; duration: number; progress?: number; path?: string }
interface Job { key: string; source: WaveformSource; from: number; to: number; relevant?: () => boolean; resolve(): void }
const regions=new Map<string,number[]>(),overviews=new Map<string,Peaks>(),fallbacks=new Map<string,{overview:number[];peaks:number[]}>();
const pending=new Map<string,Promise<void>>(),jobs:Job[]=[],listeners=new Set<()=>void>();
let running=false,revision=0;
const publish=()=>{revision++;for(const listener of listeners)listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const snapshot=()=>revision;
const sourceKey=(source:WaveformSource)=>source.sample?`sample:${source.path||`${source.bank}:${source.pad}`}:${source.duration}`:`song:${source.trackId}:${source.duration}`;
const regionKey=(source:WaveformSource,from:number,to:number)=>`${sourceKey(source)}:${from.toFixed(6)}:${to.toFixed(6)}`;
function bounded<T>(map:Map<string,T>,key:string,value:T,limit=256){map.delete(key);map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);}

export function rememberWaveform(source:WaveformSource,data:Peaks) {
  if(!Array.isArray(data.peaks)||!data.peaks.length)return;
  const key=sourceKey(source),previous=overviews.get(key);
  if(previous&&previous.progress===data.progress&&previous.peaks.length===data.peaks.length&&previous.peaks.every((peak,index)=>peak===data.peaks[index]))return;
  bounded(overviews,key,data,32);publish();
}

/** A correct source overview is immediately available while a new detail window
 * is refined. Never paint an empty/previous pad's canvas between selections. */
function readWindow(source:WaveformSource,from:number,to:number):number[] {
  const key=regionKey(source,from,to),exact=regions.get(key);
  if(exact){bounded(regions,key,exact);return exact;}
  const overview=source.peaks?.length?source.peaks:overviews.get(sourceKey(source))?.peaks;
  if(!overview?.length||source.duration<=0)return [];
  const saved=fallbacks.get(key);if(saved?.overview===overview)return saved.peaks;
  const peaks=Array.from({length:1024},(_,index)=>{
    const first=Math.max(0,Math.min(overview.length-1,Math.floor((from+(to-from)*index/1024)/source.duration*overview.length)));
    const last=Math.max(first+1,Math.min(overview.length,Math.ceil((from+(to-from)*(index+1)/1024)/source.duration*overview.length)));
    let peak=0;for(let i=first;i<last;i++)peak=Math.max(peak,overview[i]);return peak;
  });
  bounded(fallbacks,key,{overview,peaks});return peaks;
}

async function drain() {
  if(running)return;running=true;
  try{while(jobs.length){const job=jobs.shift()!;
    try{
      if(document.hidden||job.relevant&&!job.relevant())continue;
      const source={...job.source};
      if(source.sample&&source.path){
        const sample=Object.values(usePadSamples.getState().samples).find(pad=>pad.path===source.path&&pad.ready);
        if(!sample)continue;source.bank=sample.bank;source.pad=sample.pad;
      }
      const data:Peaks=await (window as any).__pluginInvoke('waveformRegion',{...source,from:job.from,to:job.to,bins:1024});
      if(source.sample&&source.path&&data.path&&source.path!==data.path)continue;
      if(Array.isArray(data.peaks)&&data.peaks.length){bounded(regions,job.key,data.peaks);publish();}
    }catch{/* A source can change while a background window is being prepared. */}
    finally{pending.delete(job.key);job.resolve();}
  }}finally{running=false;}
}

function requestWindow(source:WaveformSource,from:number,to:number,relevant?:()=>boolean):Promise<void> {
  if(to<=from||typeof (window as any).__pluginInvoke!=='function')return Promise.resolve();
  const key=regionKey(source,from,to);if(regions.has(key))return Promise.resolve();
  const existing=pending.get(key);
  if(existing){if(!relevant){const index=jobs.findIndex(job=>job.key===key);if(index>=0){const [job]=jobs.splice(index,1);job.relevant=undefined;jobs.unshift(job);}}return existing;}
  let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});pending.set(key,promise);
  const job={key,source,from,to,relevant,resolve};if(relevant)jobs.push(job);else jobs.unshift(job);
  void drain();return promise;
}

export function useWaveformWindow(source:WaveformSource,from:number,to:number) {
  useSyncExternalStore(subscribe,snapshot,snapshot);
  const key=regionKey(source,from,to);
  useEffect(()=>{void requestWindow(source,from,to);},[key]);
  return readWindow(source,from,to);
}

/** Prewarm the current bank during normal performance, before Fine is opened.
 * One request in flight keeps background decoding from flooding native storage. */
export function useWarmPadWaveforms(track:Track|null|undefined,duration:number,bank:string,cues:Record<number,number>,samples:Record<string,PadSample>,count:number,enabled:boolean) {
  useEffect(()=>{
    if(!enabled)return;
    for(let pad=1;pad<=count;pad++){
      const sample=samples[`${bank}:${pad}`],at=sample?sample.start??0:cues[pad];if(at==null||sample&&!sample.ready)continue;
      const source:WaveformSource={trackId:track?.id,sample:!!sample,bank,pad,path:sample?.path,duration:sample?.duration??duration,peaks:sample?.peaks};
      const span=Math.min(2,source.duration),from=Math.max(0,Math.min(source.duration-span,at-span/2));
      void requestWindow(source,from,from+span,()=>{const current=useCueStore.getState(),now=usePadSamples.getState().samples[`${bank}:${pad}`];return current.bank===bank&&(sample?now?.path===sample.path:(current.trackId===track?.id&&!now&&current.cues[pad]===at));});
    }
  },[track?.id,duration,bank,cues,samples,count,enabled]);
  useEffect(()=>{
    if(!enabled||!track||duration<=0)return;let disposed=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const data:Peaks=await (window as any).__pluginInvoke('waveform');if(disposed)return;rememberWaveform({trackId:track.id,bank,pad:0,duration},data);if((data.progress??0)>=1)return;}catch{}if(!disposed)timer=setTimeout(poll,500);};
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[track?.id,duration,enabled]);
}
