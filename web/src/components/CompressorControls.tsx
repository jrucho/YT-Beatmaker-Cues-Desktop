import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { changeMixer, DEFAULT_MIXER, refreshMixer, useMixer } from '../mobile/mixer';
import { beginEditGesture, endEditGesture } from '../mobile/editHistory';
import { toast } from '../stores/ui';
import { cn } from '../lib/format';

export function CompressorControls(){
  const mixer=useMixer(),[open,setOpen]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null),pointer=useRef(false);
  useEffect(()=>{void refreshMixer().catch(()=>{});return()=>{if(timer.current)clearTimeout(timer.current);};},[]);
  const change=(patch:Parameters<typeof changeMixer>[0])=>void changeMixer(patch).catch(error=>toast(error.message,'error'));
  return <><button type="button" aria-label="Compressor" aria-pressed={mixer.enabled} title="Tap: compressor · Hold: mixer" className={cn('cue-compressor shrink-0 rounded-full px-2 py-1 text-[10px]',mixer.enabled?'bg-accent text-accent-ink':'bg-surface-2 text-fg-2')}
    onPointerDown={event=>{if(event.pointerType!=='touch'&&event.button!==0)return;pointer.current=true;try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}timer.current=setTimeout(()=>{timer.current=null;setOpen(true);},600);}}
    onPointerUp={()=>{if(timer.current){clearTimeout(timer.current);timer.current=null;change({enabled:!useMixer.getState().enabled});}}}
    onPointerCancel={()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;}}
    onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')pointer.current=false;}}
    onClick={event=>{if(event.detail===0&&!pointer.current)change({enabled:!useMixer.getState().enabled});}}
  >Comp</button><Modal open={open} onClose={()=>setOpen(false)} title="Compressor & mixer">
    <div className="flex flex-col gap-4"><label className="flex items-center justify-between text-sm"><span>Compressor</span><button type="button" role="switch" aria-label="Enable compressor" aria-checked={mixer.enabled} className={cn('rounded-full px-3 py-2',mixer.enabled?'bg-accent text-accent-ink':'bg-surface-3')} onClick={()=>change({enabled:!mixer.enabled})}>{mixer.enabled?'On':'Off'}</button></label>
      {([{key:'song',label:'Song / cues'},{key:'samples',label:'Drums / samples'},{key:'output',label:'Compressor output'}] as const).map(({key,label})=><label key={key} className="flex flex-col gap-1 text-xs text-fg-2"><span className="flex justify-between"><span>{label}</span><span className="font-mono">{Math.round(mixer[key]*100)}%</span></span><input type="range" aria-label={label} min={0} max={2} step={.01} value={mixer[key]} className="w-full accent-[var(--accent)]" onPointerDown={()=>beginEditGesture('mixer')} onPointerUp={endEditGesture} onPointerCancel={endEditGesture} onChange={event=>change({[key]:Number(event.target.value)})}/></label>)}
      <button type="button" className="min-h-10 rounded-full bg-surface-3 px-4 text-sm" onClick={()=>change(DEFAULT_MIXER)}>Reset mixer</button>
    </div>
  </Modal></>;
}
