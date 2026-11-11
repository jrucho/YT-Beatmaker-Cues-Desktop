import { useEffect, useState } from 'react';
import { audioInputChoices, canonicalAudioInput, configureAudio, externalRecordingLabel, recordingGuardLabel, refreshAudioRoutes, speakerLabel, usbAudioLabel, useAudioRoutes, useRecording, useRecordingSource, type RecordingSource } from '../mobile/audioRouting';
import { mediaInvoke, playImportedAudio } from '../mobile/mediaEditing';
import { toast } from '../stores/ui';
import type { Track } from '../lib/types';
import { cn } from '../lib/format';
import { selectCurrent, usePlayer } from '../player/player';
import { useRecordingMidiGuard } from '../mobile/recordingMidiGuard';

const field='min-w-0 rounded-lg border border-line bg-surface-2 px-2 py-2 text-xs';
function RecordingInputMeter({peak=0}:{peak?:number}){
  const level=Number.isFinite(peak)?Math.max(0,peak):0,db=Math.max(-60,Math.min(0,20*Math.log10(Math.max(.001,level)))),lit=Math.max(0,Math.ceil((db+60)/60*24));
  return <div role="meter" aria-label="Recording input level" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db} aria-valuetext={level>0?`${db.toFixed(1)} decibels`:'No input'} className="rounded-xl bg-surface-2 px-3 py-2">
    <div className="mb-1 flex items-center justify-between text-[10px] text-fg-3"><span>Input</span><span className="font-mono tabular-nums">{level>0?db.toFixed(1):'−∞'} dB</span></div>
    <div className="grid h-3 gap-0.5" style={{gridTemplateColumns:'repeat(24,minmax(0,1fr))'}} aria-hidden="true">{Array.from({length:24},(_,index)=><span key={index} data-active={index<lit} className={cn('rounded-[2px]',index<lit?(index>=22?'bg-danger':'bg-accent'):'bg-surface-3')}/>)}</div>
  </div>;
}
function RecordingSourceSelect({disabled=false}:{disabled?:boolean}){
  const state=useRecording(),{source,select}=useRecordingSource();
  return <label className="flex flex-col gap-1 text-xs text-fg-2">Record from<select aria-label="Recording source" disabled={disabled||state.hasTake} value={state.hasTake?state.source:source} className={field} onChange={event=>select(event.target.value as RecordingSource)}><option value="playback">Beatmaker playback</option><option value="input">{externalRecordingLabel()}</option></select></label>;
}
export function AudioRoutingControls({midiPanelActive=true,showRecordingSource=false}:{midiPanelActive?:boolean;showRecordingSource?:boolean}={}){
  const {routes,busy}=useAudioRoutes(),hasTake=useRecording(state=>state.hasTake);
  const midiPaused=useRecordingMidiGuard(midiPanelActive);
  useEffect(()=>{void refreshAudioRoutes().catch(()=>{});const timer=setInterval(()=>void refreshAudioRoutes().catch(()=>{}),1000);return()=>clearInterval(timer);},[]);
  const change=(patch:Parameters<typeof configureAudio>[0])=>void configureAudio(patch).catch(error=>toast(error.message,'error'));
  if(!routes?.supported)return null;
  const selectedOutput=routes.output==='automatic'?'automatic':routes.activeOutput??routes.output;
  return <section className="flex flex-col gap-2" aria-label="Audio input and output settings">
    {showRecordingSource&&<RecordingSourceSelect/>}
    {showRecordingSource&&midiPaused&&<p role="status" className="text-[11px] text-fg-3">MIDI pads paused · {recordingGuardLabel()} selected</p>}
    {routes.hostManaged&&<p className="text-xs text-fg-2">Input and output are routed by your DAW.</p>}
    {!routes.hostManaged&&routes.drivers&&routes.drivers.length>1&&<label className="flex flex-col gap-1 text-xs text-fg-2">Audio driver<select aria-label="Audio driver" value={routes.driver} disabled={busy||hasTake} className={field} onChange={event=>change({driver:event.target.value,input:'automatic',output:'automatic'})}>{routes.drivers.map(driver=><option key={driver}>{driver}</option>)}</select></label>}
    <label className="flex items-center justify-between gap-2 text-xs"><span>Audio input</span><button type="button" role="switch" aria-label="Enable audio input" aria-checked={routes.inputEnabled} disabled={busy||hasTake} className={cn('rounded-full px-3 py-2',routes.inputEnabled?'bg-accent text-accent-ink':'bg-surface-3')} onClick={()=>change({inputEnabled:!routes.inputEnabled,...(routes.inputEnabled?{monitor:false}:{})})}>{routes.inputEnabled?'On':'Off'}</button></label>
    {!routes.hostManaged&&<label className="flex min-w-0 flex-col gap-1 text-xs text-fg-2">Preferred input<select aria-label="Preferred audio input" value={routes.platform==='desktop'?routes.input:canonicalAudioInput(routes)} disabled={busy||hasTake} className={field} onChange={event=>change({input:event.target.value})}>{audioInputChoices(routes).map(port=><option key={port.id} value={port.id}>{port.name}</option>)}</select></label>}
    {!routes.hostManaged&&(routes.platform==='desktop'?<label className="flex flex-col gap-1 text-xs text-fg-2">Output device<select aria-label="Preferred audio output device" value={routes.output} disabled={busy||hasTake} className={field} onChange={event=>change({output:event.target.value})}><option value="automatic">Automatic</option>{routes.outputs?.map(port=><option key={port.id} value={port.id}>{port.name}</option>)}</select></label>:<div className="flex flex-col gap-1 text-xs text-fg-2"><span>Output</span><div role="radiogroup" aria-label="Preferred audio output" className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">{([{id:'automatic',name:'Automatic'},{id:'speaker',name:speakerLabel(routes)},{id:'usb',name:usbAudioLabel(routes)}] as const).map(option=><button key={option.id} type="button" role="radio" aria-checked={selectedOutput===option.id} disabled={busy||hasTake} className={cn('min-h-10 min-w-0 rounded-lg px-1 py-2 text-[11px] font-medium leading-tight disabled:opacity-40',selectedOutput===option.id?'bg-accent text-accent-ink':'text-fg-2')} onClick={()=>change({output:option.id})}>{option.name}</button>)}</div></div>)}
    <label className="flex items-center justify-between gap-2 text-xs"><span>Input monitoring</span><button type="button" role="switch" aria-label="Input monitoring" aria-checked={routes.monitorRequested??routes.monitor} disabled={busy} className={cn('rounded-full px-3 py-2',routes.monitor?'bg-accent text-accent-ink':'bg-surface-3')} onClick={()=>change({monitor:!(routes.monitorRequested??routes.monitor)})}>{routes.monitorSuspended?(routes.hostManaged?'Muted · waiting for DAW input':'Muted · waiting for device'):routes.monitor?'On':'Off'}</button></label>
    {routes.monitor&&<label className="flex items-center gap-2 text-xs"><span>Monitor level</span><input type="range" aria-label="Monitor level" className="min-w-0 flex-1 accent-[var(--accent)]" min={0} max={1} step={.01} value={routes.monitorLevel} onChange={event=>change({monitorLevel:Number(event.target.value)})}/></label>}
    <p className="text-[11px] text-fg-3">Input: {routes.actualInput||'Off'}{routes.microphoneDataSource?` · ${routes.microphoneDataSource}`:''}<br/>Output: {routes.actualOutput||'Not ready'} · {Math.round(routes.sampleRate||0)} Hz</p>
    {routes.message&&<p className="text-[11px] text-fg-2">{routes.message}</p>}
  </section>;
}

export function AudioRecording({onSaved,onHide,onEmpty,preparing=false}:{onSaved:()=>void;onHide:()=>void;onEmpty:()=>void;preparing?:boolean}){
  const track=usePlayer(selectCurrent);
  const state=useRecording(),{source,select}=useRecordingSource(),[busy,setBusy]=useState(false);
  const midiPaused=useRecordingMidiGuard();
  const [routesOpen,setRoutesOpen]=useState(false);
  const record=async()=>{
    if(busy)return;setBusy(true);
    try{
      if(state.hasTake){
        const result=await mediaInvoke<{track:Track;message?:string}>('recordAudio',{cmd:'stop'});useRecording.setState({hasTake:false,recording:false,seconds:0});
        if(result.message)toast(result.message,'error');if(result.track){await playImportedAudio([result.track]);toast('Recording saved to Imports · ready in Cues');onSaved();}
      }else{
        if(source==='input')await configureAudio({inputEnabled:true});
        useRecording.setState(await mediaInvoke('recordAudio',{cmd:'start',source}));
        select(source);
      }
    }catch(error){toast((error as Error).message,'error');}finally{setBusy(false);}
  };
  return <div className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-2 text-xs text-fg-2"><span className="min-w-0 truncate">{track?track.title:'Empty track · ready to record'}</span>{track&&<button type="button" disabled={busy||preparing} className="shrink-0 rounded-full bg-surface-3 px-3 py-2" onClick={onEmpty}>New empty track</button>}</div>
    <RecordingSourceSelect disabled={busy}/>
    {midiPaused&&<p role="status" className="text-[11px] text-fg-3">MIDI pads paused · {recordingGuardLabel()} selected</p>}
    <div className="flex items-center justify-between gap-3"><strong className="font-mono text-xl tabular-nums">{Math.floor(state.seconds/60)}:{String(Math.floor(state.seconds%60)).padStart(2,'0')}</strong>{state.hasTake&&<span className={cn('text-xs',state.recording?'text-danger':'text-fg-2')}>{state.recording?'Recording':'Stopped'}</span>}</div>
    {(state.hasTake?state.source:source)==='input'&&<RecordingInputMeter peak={state.inputPeak}/>}
    {state.message&&<p role="status" className="text-xs text-fg-2">{state.message}</p>}
    <button type="button" disabled={busy||preparing} className="min-h-11 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-ink disabled:opacity-40" onClick={()=>void record()}>{busy?'Saving…':state.hasTake?'Finish & play in Cues':'Start recording'}</button>
    {state.hasTake&&<button type="button" className="min-h-10 rounded-full bg-surface-3 px-3 text-xs" onClick={onHide}>Keep recording · play pads</button>}
    <button type="button" className="min-h-9 rounded-full bg-surface-3 px-3 text-xs" onClick={()=>setRoutesOpen(value=>!value)}>Audio input & output</button>
    {routesOpen&&<AudioRoutingControls/>}
    <p className="text-[11px] text-fg-3">Finished takes appear in Imports and Cues automatically.</p>
  </div>;
}
