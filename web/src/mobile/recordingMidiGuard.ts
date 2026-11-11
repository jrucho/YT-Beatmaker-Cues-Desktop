import { useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';
import { useRecording, useRecordingSource } from './audioRouting';
import { iosPadLayoutEnabled } from './padLayout';
import { mediaInvoke } from './mediaEditing';

const panels=new Set<symbol>();
const useGuard=create<{suspended:boolean}>(()=>({suspended:false}));
let sent:boolean|undefined;
export const recordingMidiSuspended=()=>useGuard.getState().suspended;
function sync(){
  if(!iosPadLayoutEnabled())return;
  const take=useRecording.getState(),source=take.hasTake?take.source:useRecordingSource.getState().source;
  const suspended=panels.size>0&&source==='input';
  if(suspended!==recordingMidiSuspended())useGuard.setState({suspended});
  if(sent===suspended)return;sent=suspended;
  void mediaInvoke('midiOptions',{suspendPadActions:suspended}).catch(error=>{sent=undefined;console.error(error);});
}
useRecording.subscribe(sync);useRecordingSource.subscribe(sync);
// A fresh document clears this editor's old transient guard after a refresh.
if(typeof window!=='undefined')sync();

/** Nested recorder/routing panels share one guard. Only visible panels count;
 * playback resampling always keeps MIDI active. This is not a saved MIDI mode. */
export function useRecordingMidiGuard(visible=true){
  const token=useRef(Symbol('recording MIDI panel'));
  useLayoutEffect(()=>{
    if(!visible||!iosPadLayoutEnabled())return;
    const id=token.current;panels.add(id);sync();
    return()=>{panels.delete(id);sync();};
  },[visible]);
  return useGuard(state=>visible&&state.suspended);
}
