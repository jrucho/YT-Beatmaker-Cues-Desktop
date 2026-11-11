import { useEffect, useState } from "react";

export interface PadEvent { bank: string; pad: number; phase: "pressed" | "triggered" | "released"; velocity?: number; source?: 'pointer' | 'midi' | 'native' }
const holds=new Map<string,Set<string>>();
export const isPadHeld=(bank:string,pad:number)=>(holds.get(`${bank}:${pad}`)?.size??0)>0;
export function releasePointerPadHolds() {
  for(const [key,sources] of holds)if(sources.has('pointer')){const [bank,pad]=key.split(':');padFeedback({bank,pad:Number(pad),phase:'released',source:'pointer'});}
}
if(typeof window!=='undefined')window.addEventListener('beatmaker-pad',event=>{
  const {bank,pad,phase,source='legacy'}=(event as CustomEvent<PadEvent>).detail;
  if(phase==='triggered')return;const key=`${bank}:${pad}`,sources=holds.get(key)??new Set<string>();
  if(phase==='pressed')sources.add(source);else sources.delete(source);
  if(sources.size)holds.set(key,sources);else holds.delete(key);
});
if(typeof window!=='undefined'){
  window.addEventListener('blur',releasePointerPadHolds);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)releasePointerPadHolds();});
}
export function padFeedback(event: PadEvent) { window.dispatchEvent(new CustomEvent("beatmaker-pad", { detail: event })); }
export function usePadFeedback() {
  const [pressed, setPressed] = useState<Set<string>>(()=>new Set(holds.keys()));
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const listener = (event: Event) => {
      const { bank, pad, phase } = (event as CustomEvent<PadEvent>).detail;
      const key = `${bank}:${pad}`;
      if (phase === "pressed" || phase === "released") setPressed(previous => {
        const next = new Set(previous); isPadHeld(bank,pad) ? next.add(key) : next.delete(key); return next;
      });
      if (phase === "triggered") {
        setActive(key); setFlashing(previous => new Set(previous).add(key));
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => { setFlashing(previous => { const next = new Set(previous); next.delete(key); return next; }); timers.delete(key); }, 100));
      }
    };
    window.addEventListener("beatmaker-pad", listener);
    return () => { window.removeEventListener("beatmaker-pad", listener); for (const timer of timers.values()) clearTimeout(timer); };
  }, []);
  return { pressed, flashing, active };
}
