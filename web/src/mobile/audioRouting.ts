import { useEffect } from 'react';
import { create } from 'zustand';
import { mediaInvoke, recoverImportedAudio } from './mediaEditing';
import { nativePlatform } from './padLayout';

export interface AudioPreferences {inputEnabled:boolean;input:string;output:string;driver?:string;monitor:boolean;monitorLevel:number;monitorRoute?:{inputs:string[];outputs:string[]}}
export interface AudioPort {id:string;name:string;type:string;kind?:'microphone'|'speaker'|'usb'|'other'}
export interface AudioRoutes extends AudioPreferences {supported:boolean;platform?:string;hostManaged?:boolean;drivers?:string[];inputActive:boolean;permission:string;sampleRate:number;inputs:AudioPort[];outputs?:AudioPort[];actualInput:string;actualOutput:string;activeOutput?:'speaker'|'usb'|'other';outputAccepted?:boolean;inputAccepted?:boolean;microphoneDataSource?:string;microphonePosition?:string;monitorRequested?:boolean;monitorSuspended?:boolean;message?:string}
export const microphoneLabel=(routes:AudioRoutes)=>(routes.platform??nativePlatform())==='ios'?'iPhone microphone':'Built-in microphone';
export const speakerLabel=(routes:AudioRoutes)=>(routes.platform??nativePlatform())==='ios'?'iPhone speaker':'Device speaker';
export const externalRecordingLabel=()=>((window as any).__pluginHosted?'DAW audio input':'Microphone / USB input');
export const recordingGuardLabel=()=>((window as any).__pluginHosted?'DAW input':'microphone / USB');
const portKind=(port:AudioPort)=>port.kind??(/MicrophoneBuiltIn/i.test(port.type)?'microphone':/USBAudio/i.test(port.type)?'usb':'other');
export function canonicalAudioInput(routes:AudioRoutes){const port=routes.inputs?.find(port=>port.id===routes.input),kind=port&&portKind(port);return kind==='microphone'||kind==='usb'?kind:routes.input;}
export function usbAudioLabel(routes:AudioRoutes){
  const ports=[...(routes.inputs??[]),...(routes.outputs??[])].filter(port=>portKind(port)==='usb');
  if(ports.some(port=>/sp[\s_-]*404/i.test(port.name)))return 'SP-404';
  return ports[0]?.name.trim()||'USB interface';
}
export function audioInputChoices(routes:AudioRoutes){
  if(routes.platform==='desktop')return [{id:'automatic',name:'Automatic'},...(routes.inputs??[]).map(({id,name})=>({id,name}))];
  const choices=[{id:'automatic',name:'Automatic'},{id:'microphone',name:microphoneLabel(routes)},{id:'usb',name:usbAudioLabel(routes)}],seen=new Set<string>();
  for(const port of routes.inputs??[]){
    if(portKind(port)==='microphone'||portKind(port)==='usb')continue;
    const key=`${port.type}:${port.name.trim().toLowerCase()}`;if(seen.has(key))continue;seen.add(key);choices.push({id:port.id,name:port.name});
  }
  return choices;
}
export interface RecordingState {hasTake:boolean;recording:boolean;seconds:number;source:'input'|'playback';message?:string;inputPeak?:number}
export type RecordingSource='input'|'playback';
const readRecordingSource=():RecordingSource=>{try{return localStorage.getItem('musike:recording:source')==='input'?'input':'playback';}catch{return 'playback';}};
export const useRecordingSource=create<{source:RecordingSource;select(source:RecordingSource):void}>(set=>({
  source:readRecordingSource(),
  select:source=>{localStorage.setItem('musike:recording:source',source);set({source});window.dispatchEvent(new Event('plugin-preferences-changed'));},
}));
if(typeof window!=='undefined')window.addEventListener('plugin-preferences-changed',()=>{const source=readRecordingSource();if(source!==useRecordingSource.getState().source)useRecordingSource.setState({source});});
export const useAudioRoutes=create<{routes:AudioRoutes|null;busy:boolean}>(()=>({routes:null,busy:false}));
export const useRecording=create<RecordingState>(()=>({hasTake:false,recording:false,seconds:0,source:'playback'}));
function saveAudioRoutes(routes:AudioRoutes){
  if(!routes.supported)return;
  const {inputEnabled,input,output,driver,monitorLevel,monitorRoute}=routes;
  const value=JSON.stringify({inputEnabled,input,output,monitor:routes.monitorRequested??routes.monitor,monitorLevel,...(monitorRoute?{monitorRoute}:{}),...(driver?{driver}:{})});
  if(localStorage.getItem('musike:audio:routes')!==value){localStorage.setItem('musike:audio:routes',value);window.dispatchEvent(new Event('plugin-preferences-changed'));}
}
export async function refreshAudioRoutes(){const routes=await mediaInvoke<AudioRoutes>('audioRoutes');useAudioRoutes.setState({routes});saveAudioRoutes(routes);return routes;}
let updates:Promise<unknown>=Promise.resolve();
export function configureAudio(patch:Partial<AudioPreferences>):Promise<AudioRoutes>{
  const work=updates.catch(()=>{}).then(async()=>{
    useAudioRoutes.setState({busy:true});
    try{
      const routes=await mediaInvoke<AudioRoutes>('configureAudio',patch);
      if(!routes?.supported)throw new Error('Audio routing is unavailable in this wrapper');
      useAudioRoutes.setState({routes});saveAudioRoutes(routes);return routes;
    }catch(error){await refreshAudioRoutes().catch(()=>{});throw error;}
    finally{useAudioRoutes.setState({busy:false});}
  });updates=work;return work;
}
export function useRecordingStatus(enabled:boolean){
  useEffect(()=>{if(!enabled)return;let stopped=false,busy=false;
    void recoverImportedAudio().catch(console.error);
    const poll=async()=>{if(busy)return;busy=true;try{const state=await mediaInvoke<RecordingState>('recordAudio',{cmd:'state'});if(!stopped&&state)useRecording.setState(state);}catch{}finally{busy=false;}};
    void poll();const timer=setInterval(poll,200);return()=>{stopped=true;clearInterval(timer);};
  },[enabled]);
}
