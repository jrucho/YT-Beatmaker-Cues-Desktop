import {useEffect,useRef,useState} from 'react';
import {useCueStore} from '../mobile/cueStore';
import {selectCurrent,usePlayer} from '../player/player';
import {usePadSamples} from '../mobile/padSamples';
import {playerShortcutsEnabled} from '../native/host';

/** Native audio peaks, built off the audio callback; markers edit the current bank. */
export function CueWaveform({padCount=16}:{padCount?:number}){
  const track=usePlayer(selectCurrent),duration=usePlayer(s=>s.duration),position=usePlayer(s=>s.position);
  const cues=useCueStore(s=>s.cues),bank=useCueStore(s=>s.bank);
  const samples=usePadSamples(s=>s.samples);
  const root=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  const [data,setData]=useState<{peaks:number[];progress:number}>({peaks:[],progress:0});
  const invoke=(window as unknown as {__pluginInvoke?: (name:string)=>Promise<{peaks:number[];progress:number}>}).__pluginInvoke;
  const visible=true;
  useEffect(()=>{
    setData({peaks:[],progress:0});if(!invoke||!visible||!track)return;
    let disposed=false,busy=false;
    const poll=async()=>{if(busy)return;busy=true;try{const value=await invoke('waveform');if(!disposed)setData(value);}catch{}finally{busy=false;}};
    void poll();const timer=setInterval(()=>void poll(),1000);
    return()=>{disposed=true;clearInterval(timer);};
  },[track?.id,visible,invoke]);
  useEffect(()=>{
    const node=canvas.current;if(!node)return;
    const draw=()=>{
      const width=node.clientWidth,height=node.clientHeight,scale=devicePixelRatio||1;
      node.width=Math.max(1,Math.round(width*scale));node.height=Math.max(1,Math.round(height*scale));
      const context=node.getContext('2d');if(!context)return;context.scale(scale,scale);
      context.fillStyle=getComputedStyle(node).getPropertyValue('--accent')||'#c3ec52';
      const peak=Math.max(.01,...data.peaks);
      data.peaks.forEach((value,index)=>{const h=Math.max(1,Math.min(1,value/peak)*(height-12));context.fillRect(index*width/data.peaks.length,(height-h)/2,Math.max(1,width/data.peaks.length-1),h);});
      if(duration>0){context.fillStyle='#ffffff';context.fillRect(position/duration*width,0,1,height);}
    };
    draw();const observer=new ResizeObserver(draw);observer.observe(node);return()=>observer.disconnect();
  },[data,position,duration,visible]);
  if(!invoke||!visible)return null;
  const timeAt=(clientX:number)=>{const bounds=root.current!.getBoundingClientRect();return Math.max(0,Math.min(duration,(clientX-bounds.left)/bounds.width*duration));};
  return <div ref={root} className="cue-waveform" data-waveform-progress={data.progress} data-peak-count={data.peaks.length} aria-label="Song waveform" onPointerDown={event=>{if(event.button===0&&duration>0){const time=timeAt(event.clientX);if(event.metaKey||event.ctrlKey||event.shiftKey)useCueStore.getState().setNextCue(time);else usePlayer.getState().seek(time);}}} onDoubleClick={event=>{if(duration>0)useCueStore.getState().setNextCue(timeAt(event.clientX));}}>
    <canvas ref={canvas} aria-hidden="true"/>
    {duration>0&&Object.entries(cues).filter(([number])=>Number(number)<=padCount&&!samples[`${bank}:${number}`]).map(([number,time])=><button key={number} type="button" role="slider" aria-label={`Move cue ${bank}${number}`} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time} className="cue-wave-marker" style={{left:`${time/duration*100}%`}}
      onPointerDown={event=>{event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))useCueStore.getState().setCue(Number(number),timeAt(event.clientX));}}
      onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onDoubleClick={event=>{event.stopPropagation();useCueStore.getState().clearCue(Number(number));}}
      onKeyDown={event=>{if(playerShortcutsEnabled()&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();event.stopPropagation();useCueStore.getState().setCue(Number(number),Math.max(0,Math.min(duration,time+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey ? 0.1 : 0.01))));}}}
    />)}
  </div>;
}
