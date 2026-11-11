import {useEffect,useLayoutEffect,useRef} from 'react';
import {playbackDisplayPosition,usePlayer} from './player';

/** Paint just the moving indicator at display refresh rate, without React/store
 * updates or a native bridge call per frame. Pause/background/unmount stop RAF. */
export function usePlaybackFrame(draw:(seconds:number)=>void,enabled=true){
  const paint=useRef(draw);
  useLayoutEffect(()=>{paint.current=draw;if(enabled)draw(playbackDisplayPosition());});
  useEffect(()=>{
    if(!enabled)return;
    let frame:number|null=null;
    const playing=()=>document.visibilityState!=='hidden'&&usePlayer.getState().status==='playing';
    const tick=()=>{frame=null;paint.current(playbackDisplayPosition());if(playing())frame=requestAnimationFrame(tick);};
    const refresh=()=>{paint.current(playbackDisplayPosition());if(playing()){if(frame==null)frame=requestAnimationFrame(tick);}else if(frame!=null){cancelAnimationFrame(frame);frame=null;}};
    const unsubscribe=usePlayer.subscribe((state,previous)=>{if(state.status!==previous.status||state.position!==previous.position||state.index!==previous.index||state.queue!==previous.queue||state.speed!==previous.speed||state.loop!==previous.loop)refresh();});
    document.addEventListener('visibilitychange',refresh);refresh();
    return()=>{unsubscribe();document.removeEventListener('visibilitychange',refresh);if(frame!=null)cancelAnimationFrame(frame);};
  },[enabled]);
}
