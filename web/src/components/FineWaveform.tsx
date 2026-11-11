import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MinusIcon, PlusIcon, PlayIcon } from '@phosphor-icons/react';
import { useCueStore } from '../mobile/cueStore';
import { playPadSample, setPadSampleStart, usePadSamples } from '../mobile/padSamples';
import { selectCurrent, usePlayer } from '../player/player';
import { toast } from '../stores/ui';
import { useAppearance } from '../stores/appearance';
import { useWaveformWindow } from '../mobile/waveforms';
import { isPadHeld } from '../mobile/padFeedback';
import { readAlwaysAudition } from '../mobile/waveformPreferences';

export function FineWaveform({pad}:{pad:number}) {
  const track=usePlayer(selectCurrent),songDuration=usePlayer(state=>state.duration);
  const bank=useCueStore(state=>state.bank),cue=useCueStore(state=>state.cues[pad]);
  const sample=usePadSamples(state=>state.samples[`${bank}:${pad}`]);
  const duration=sample?.duration ?? songDuration,value=sample?sample.start ?? 0:cue ?? usePlayer.getState().position;
  const [marker,setMarker]=useState(value),[center,setCenter]=useState(value),[span,setSpan]=useState(2);
  const [busy,setBusy]=useState(false);
  const drag=useRef<number|null>(null),root=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  const pointer=useRef<number|null>(null),frame=useRef<number|null>(null),lastAudition=useRef<number|null>(null);
  const accent=useAppearance(state=>state.accent);
  const width=Math.max(.001,Math.min(duration || 2,span));
  const from=Math.max(0,Math.min(Math.max(0,duration-width),center-width/2)),to=Math.min(duration,from+width);
  const peaks=useWaveformWindow({sample:!!sample,trackId:track?.id,bank,pad,path:sample?.path,duration,peaks:sample?.peaks},from,to);
  useEffect(()=>{setMarker(value);setCenter(value);setSpan(2);},[track?.id,bank,pad,sample?.path]);
  useEffect(()=>{if(drag.current==null)setMarker(value);},[value]);
  useEffect(()=>()=>{if(frame.current!=null)cancelAnimationFrame(frame.current);},[]);
  useLayoutEffect(()=>{
    const node=canvas.current;if(!node)return;
    const draw=()=>{const w=node.clientWidth,h=node.clientHeight,dpr=devicePixelRatio||1;node.width=Math.max(1,Math.round(w*dpr));node.height=Math.max(1,Math.round(h*dpr));
      const context=node.getContext('2d');if(!context)return;context.scale(dpr,dpr);context.fillStyle=getComputedStyle(node).getPropertyValue('--accent');
      const max=Math.max(.01,...peaks);peaks.forEach((peak,i)=>{const size=Math.max(1,peak/max*(h-8));context.fillRect(i*w/peaks.length,(h-size)/2,Math.max(1,w/peaks.length),size);});};
    draw();const resize=new ResizeObserver(draw);resize.observe(node);return()=>resize.disconnect();
  },[peaks,accent]);
  const at=(x:number)=>{const bounds=root.current!.getBoundingClientRect();return Math.max(0,Math.min(Math.max(0,duration-.00002),from+(x-bounds.left)/bounds.width*(to-from)));};
  const audition=(next:number)=>{
    // Read the live input/setting at the queued frame, not a render-time boolean:
    // releasing the pad must also silence an already queued drag update.
    if(!readAlwaysAudition()&&!isPadHeld(bank,pad)){lastAudition.current=null;return;}
    if(useCueStore.getState().trackId!==(track?.id??null)||useCueStore.getState().bank!==bank||lastAudition.current===next)return;
    lastAudition.current=next;
    if(sample)void (window as any).__pluginInvoke('padSample',{cmd:'preview',bank,pad,start:next}).catch((error:Error)=>toast(error.message,'error'));
    else usePlayer.getState().cue(next);
  };
  const move=(x:number)=>{
    drag.current=at(x);setMarker(drag.current);
    if(frame.current==null)frame.current=requestAnimationFrame(()=>{frame.current=null;if(drag.current!=null)audition(drag.current);});
  };
  const finish=()=>{
    const next=drag.current;if(frame.current!=null){cancelAnimationFrame(frame.current);frame.current=null;}
    pointer.current=null;if(next==null)return;audition(next);drag.current=null;
    if(sample){setBusy(true);void setPadSampleStart(bank,pad,next).catch(error=>{setMarker(value);toast(error.message,'error');}).finally(()=>setBusy(false));}
    else if(useCueStore.getState().trackId===track?.id&&useCueStore.getState().bank===bank)useCueStore.getState().setCue(pad,next);
  };
  return <section className="cue-fine-editor" aria-label="Fine waveform editor">
    <div className="cue-fine-tools"><span>{bank}{pad} · {sample?'Start':'Cue'} <strong>{marker.toFixed(3)} s</strong></span><span className="flex gap-1">
      <button type="button" aria-label="Zoom waveform out" onClick={()=>{setCenter(marker);setSpan(Math.min(10,span*2));}}><MinusIcon size={14}/></button>
      <button type="button" aria-label="Zoom waveform in" onClick={()=>{setCenter(marker);setSpan(Math.max(.02,span/2));}}><PlusIcon size={14}/></button>
      <button type="button" aria-label="Preview selected pad" disabled={busy||duration<=0} onClick={()=>{if(sample)void playPadSample(bank,pad).catch(error=>toast(error.message,'error'));else usePlayer.getState().cue(marker,{bank,pad});}}><PlayIcon size={14} weight="fill"/></button>
    </span></div>
    <div ref={root} className="cue-waveform cue-fine-waveform" aria-label={sample?'Edit sample start waveform':'Edit selected cue waveform'} data-window-from={from} data-window-to={to} data-peak-count={peaks.length}
      onPointerDown={event=>{if((event.pointerType!=='touch'&&event.button!==0)||busy||duration<=0||pointer.current!=null)return;pointer.current=event.pointerId;lastAudition.current=null;try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}move(event.clientX);}}
      onPointerMove={event=>{if(pointer.current===event.pointerId)move(event.clientX);}}
      onPointerUp={event=>{if(pointer.current===event.pointerId){move(event.clientX);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);finish();}}}
      onPointerCancel={()=>{if(frame.current!=null){cancelAnimationFrame(frame.current);frame.current=null;}pointer.current=null;drag.current=null;setMarker(value);}}>
      <canvas ref={canvas} aria-hidden="true"/>
      <span className="cue-fine-marker" style={{left:`${Math.max(0,Math.min(100,(marker-from)/Math.max(.001,to-from)*100))}%`}} aria-hidden="true"/>
    </div>
  </section>;
}
