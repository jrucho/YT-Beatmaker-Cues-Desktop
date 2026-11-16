import {useRef,type ComponentProps} from 'react';
import {beginEditGesture,endEditGesture} from '../mobile/editHistory';

/** Native range behavior plus a paired touch tap; dragging never counts as a tap. */
export function ResettableRange({onReset,gesture,...props}:Omit<ComponentProps<'input'>,'type'> & {onReset:()=>void;gesture:string}){
  const tap=useRef({started:0,x:0,y:0,moved:false,previous:0,previousX:0,previousY:0});
  return <input {...props} type="range"
    onDoubleClick={event=>{if(event.detail===2)onReset();}}
    onPointerDown={event=>{
      if(!event.isPrimary||event.button!==0){tap.current.previous=0;return;}
      beginEditGesture(gesture);const state=tap.current;
      state.started=performance.now();state.x=event.clientX;state.y=event.clientY;state.moved=false;
    }}
    onPointerMove={event=>{const state=tap.current;if(Math.hypot(event.clientX-state.x,event.clientY-state.y)>10)state.moved=true;}}
    onPointerUp={event=>{
      const state=tap.current,now=performance.now();
      if(event.isPrimary&&event.pointerType!=='mouse'&&!state.moved&&now-state.started<=300){
        if(state.previous>0&&now-state.previous<350&&Math.hypot(event.clientX-state.previousX,event.clientY-state.previousY)<24){onReset();state.previous=0;}
        else{state.previous=now;state.previousX=event.clientX;state.previousY=event.clientY;}
      }else state.previous=0;
      endEditGesture();
    }}
    onPointerCancel={()=>{tap.current.previous=0;endEditGesture();}}
  />;
}
