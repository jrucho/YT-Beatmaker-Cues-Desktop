import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileAudioIcon, FilePlusIcon, ImagesIcon, PlayIcon, StopIcon } from '@phosphor-icons/react';
import { Modal } from './Modal';
import type { Track } from '../lib/types';
import { toast } from '../stores/ui';
import { usePlayer } from '../player/player';
import { CUE_BANKS, useCueStore } from '../mobile/cueStore';
import { usePadSamples } from '../mobile/padSamples';
import { assignAudioChops, mediaInvoke, playImportedAudio, type SamplerSource } from '../mobile/mediaEditing';
import { rememberWaveform } from '../mobile/waveforms';
import { useAppearance } from '../stores/appearance';
import { cn } from '../lib/format';
import { AudioRecording } from './AudioRecording';

export interface MediaRequest { track?:Track; bank?:string; pad?:number; record?:boolean }
const button='flex min-h-10 items-center justify-center gap-2 rounded-full bg-surface-3 px-3 py-2 text-xs font-medium disabled:opacity-40';
const primary=button+' bg-accent text-accent-ink';
const input='min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm';

function ChopWaveform({source,from,to,onChange}:{source:SamplerSource;from:number;to:number;onChange:(from:number,to:number)=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),drag=useRef<{id:number;edge:'from'|'to'}|null>(null),accent=useAppearance(state=>state.accent);
  useLayoutEffect(()=>{
    const node=canvas.current;if(!node)return;
    const draw=()=>{const w=node.clientWidth,h=node.clientHeight,dpr=devicePixelRatio||1;node.width=Math.max(1,Math.round(w*dpr));node.height=Math.max(1,Math.round(h*dpr));const ctx=node.getContext('2d');if(!ctx)return;ctx.scale(dpr,dpr);ctx.fillStyle=getComputedStyle(node).getPropertyValue('--accent');const max=Math.max(.01,...source.peaks);source.peaks.forEach((peak,index)=>{const size=Math.max(1,peak/max*(h-8));ctx.fillRect(index*w/source.peaks.length,(h-size)/2,Math.max(1,w/source.peaks.length),size);});};
    draw();const observer=new ResizeObserver(draw);observer.observe(node);return()=>observer.disconnect();
  },[source,accent]);
  const change=(node:HTMLElement,x:number)=>{const r=node.getBoundingClientRect(),at=Math.max(0,Math.min(source.duration,(x-r.left)/r.width*source.duration));if(drag.current?.edge==='from')onChange(Math.min(at,to-.001),to);else onChange(from,Math.max(from+.001,at));};
  return <div className="cue-waveform media-chop-waveform" aria-label="Chop source waveform" onPointerDown={event=>{if(event.pointerType!=='touch'&&event.button!==0)return;const r=event.currentTarget.getBoundingClientRect(),at=(event.clientX-r.left)/r.width*source.duration;drag.current={id:event.pointerId,edge:Math.abs(at-from)<Math.abs(at-to)?'from':'to'};try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}change(event.currentTarget,event.clientX);}} onPointerMove={event=>{if(drag.current?.id===event.pointerId)change(event.currentTarget,event.clientX);}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
    <canvas ref={canvas} aria-hidden="true"/><span className="media-chop-range" style={{left:`${from/source.duration*100}%`,width:`${(to-from)/source.duration*100}%`}} aria-hidden="true"/>
  </div>;
}

export function MediaImportPanel({request,padCount,onClose}:{request:MediaRequest;padCount:number;onClose:()=>void}) {
  const samples=usePadSamples(state=>state.samples);
  const [stage,setStage]=useState<'menu'|'chop'|'record'>(request.record?'record':'menu'),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const [source,setSource]=useState<SamplerSource|null>(null),[from,setFrom]=useState(0),[to,setTo]=useState(0),[slices,setSlices]=useState(1);
  const [bank,setBank]=useState(request.bank??useCueStore.getState().bank),[pad,setPad]=useState(request.pad??1);
  const epoch=useRef(0),working=useRef(false);
  const run=async(label:string,work:(active:()=>boolean)=>Promise<void>)=>{
    if(working.current)return;working.current=true;setBusy(true);setStatus(label);const token=epoch.current,active=()=>token===epoch.current;
    try{await work(active);}catch(error){if(active())toast((error as Error).message,'error');}
    finally{if(active()){working.current=false;setBusy(false);setStatus('');}}
  };
  const prepare=(track:Track)=>void run('Preparing source audio…',async active=>{
    let player=usePlayer.getState();
    if(player.queue[player.index]?.id!==track.id)player.playList([track]);
    const deadline=performance.now()+90000;
    while(active()){
      player=usePlayer.getState();const media=(window as any).__musikeAudioEl;
      if(player.queue[player.index]?.id!==track.id)throw new Error('Source song changed');
      if(media?.readyState>0)break;
      if(player.status==='error'||performance.now()>deadline)throw new Error('Could not prepare this song; try loading it again');
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    if(!active())return;player=usePlayer.getState();if(player.status==='playing')player.toggle();
    const value=await mediaInvoke<SamplerSource>('samplerSource',track);if(!active())return;
    setSource(value);setFrom(0);setTo(value.duration);setSlices(1);setStage('chop');
    rememberWaveform({trackId:value.id,bank,pad,duration:value.duration},{peaks:value.peaks,duration:value.duration,progress:1});
  });
  useEffect(()=>{
    epoch.current++;working.current=false;
    if(request.track)prepare(request.track);
    return()=>{epoch.current++;void mediaInvoke('samplerPreview',{cmd:'stop'}).catch(()=>{});};
  },[]);
  const importSource=(gallery:boolean)=>void run(gallery?'Opening gallery…':'Importing audio…',async active=>{
    const result=await mediaInvoke<{tracks:Track[];errors:{file:string;message:string}[]}>(gallery?'importGallery':'importAudio',{multiple:!gallery});
    if(result.errors?.length)toast(result.errors.map(error=>`${error.file}: ${error.message}`).join('\n'),'error');
    if(result.tracks?.length){await playImportedAudio(result.tracks);if(active()){toast('Saved to Imports · ready in Cues');onClose();}}
  });
  const newEmpty=()=>void run('Preparing empty track…',async active=>{await usePlayer.getState().newEmptyTrack();if(active())setStage('record');});
  const count=Math.max(1,Math.min(slices,padCount-pad+1)),lastPad=pad+count-1;
  const replacing=Array.from({length:count},(_,index)=>samples[`${bank}:${pad+index}`]||useCueStore.getState().cues[pad+index]!=null).filter(Boolean).length;
  return <Modal open onClose={()=>{epoch.current++;onClose();}} title={stage==='record'?'Record audio':stage==='chop'?'Chop audio':'Import audio'}>
    <div className="media-import-panel scroll-area max-h-[68dvh] overflow-y-auto">
      {busy&&<p role="status" className="pb-3 text-xs text-fg-2">{status}</p>}
      {stage==='menu'&&<div className="flex flex-col gap-2">
        <button type="button" disabled={busy} className={button} onClick={()=>importSource(false)}><FileAudioIcon size={18}/>Files…</button>
        <button type="button" aria-label="Import gallery video" disabled={busy} className={button} onClick={()=>importSource(true)}><ImagesIcon size={18}/>{(window as any).__JUCE__?.initialisationData.desktopPlatform?.[0]?'Video files…':'Phone gallery'}</button>
        <button type="button" disabled={busy} className={button} onClick={()=>setStage('record')}><span className="size-3 rounded-full bg-danger"/>Record audio</button>
        <button type="button" disabled={busy} className={button} onClick={newEmpty}><FilePlusIcon size={18}/>New empty track</button>
      </div>}
      {stage==='record'&&<AudioRecording onSaved={onClose} onHide={onClose} onEmpty={newEmpty} preparing={busy}/>}
      {stage==='chop'&&source&&<div className="flex flex-col gap-3">
        <p className="truncate text-sm font-medium">{source.title}</p>
        <ChopWaveform source={source} from={from} to={to} onChange={(a,b)=>{setFrom(Math.max(0,a));setTo(Math.min(source.duration,b));}}/>
        <div className="grid grid-cols-2 gap-2"><label className="flex min-w-0 flex-col gap-1 text-xs text-fg-2">From · s<input type="number" aria-label="Chop start seconds" min={0} max={to-.001} step={.001} value={Number(from.toFixed(3))} onChange={event=>setFrom(Math.max(0,Math.min(to-.001,Number(event.target.value))))} className={input}/></label><label className="flex min-w-0 flex-col gap-1 text-xs text-fg-2">To · s<input type="number" aria-label="Chop end seconds" min={from+.001} max={source.duration} step={.001} value={Number(to.toFixed(3))} onChange={event=>setTo(Math.min(source.duration,Math.max(from+.001,Number(event.target.value))))} className={input}/></label></div>
        <div className="flex gap-2"><button type="button" disabled={busy||to<=from} className={button} onClick={()=>void run('Preparing preview…',async()=>{await mediaInvoke('samplerPreview',{sourceId:source.id,from,to:Math.min(to,from+30)});})}><PlayIcon size={16}/>Preview{to-from>30?' · first 30 s':''}</button><button type="button" className={button} aria-label="Stop chop preview" onClick={()=>void mediaInvoke('samplerPreview',{cmd:'stop'}).catch(error=>toast(error.message,'error'))}><StopIcon size={16}/></button></div>
        <div className="grid grid-cols-3 gap-2"><label className="flex min-w-0 flex-col gap-1 text-xs text-fg-2">Bank<select aria-label="Chop destination bank" value={bank} onChange={event=>setBank(event.target.value)} className={input}>{CUE_BANKS.map(value=><option key={value}>{value}</option>)}</select></label><label className="flex min-w-0 flex-col gap-1 text-xs text-fg-2">First pad<select aria-label="Chop first pad" value={pad} onChange={event=>setPad(Number(event.target.value))} className={input}>{Array.from({length:padCount},(_,i)=><option key={i+1}>{i+1}</option>)}</select></label><label className="flex min-w-0 flex-col gap-1 text-xs text-fg-2">Slices<select aria-label="Chop slices" value={count} onChange={event=>setSlices(Number(event.target.value))} className={input}>{Array.from({length:padCount-pad+1},(_,i)=><option key={i+1}>{i+1}</option>)}</select></label></div>
        <p className="text-[11px] text-fg-3">{count} {count===1?'slice':'equal slices'} · {(to-from).toFixed(3)} s{replacing?` · ${replacing} occupied ${replacing===1?'pad':'pads'}`:''}</p>
        <button type="button" disabled={busy||to<=from} className={primary} onClick={()=>void run('Assigning chops…',async active=>{await mediaInvoke('samplerPreview',{cmd:'stop'});await assignAudioChops({sourceId:source.id,from,to,slices:count,bank,pad});if(active()){useCueStore.getState().setBank(bank);toast(`Assigned ${bank}${pad}${lastPad!==pad?`–${bank}${lastPad}`:''}`);onClose();}})}>{replacing?'Replace':'Assign'} {bank}{pad}{lastPad!==pad?`–${bank}${lastPad}`:''}</button>
      </div>}
      {stage!=='menu'&&!busy&&<button type="button" className={cn(button,'mt-3 w-full bg-transparent text-fg-3')} onClick={()=>{void mediaInvoke('samplerPreview',{cmd:'stop'}).catch(()=>{});setStage('menu');}}>Sources</button>}
    </div>
  </Modal>;
}
