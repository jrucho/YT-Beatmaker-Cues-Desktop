import { useEffect, useState } from "react";

export interface PadEvent { bank: string; pad: number; phase: "pressed" | "triggered" | "released"; velocity?: number }
export function padFeedback(event: PadEvent) { window.dispatchEvent(new CustomEvent("beatmaker-pad", { detail: event })); }
export function usePadFeedback() {
  const [pressed, setPressed] = useState<Set<string>>(new Set());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const listener = (event: Event) => {
      const { bank, pad, phase } = (event as CustomEvent<PadEvent>).detail;
      const key = `${bank}:${pad}`;
      if (phase === "pressed" || phase === "released") setPressed(previous => {
        const next = new Set(previous); phase === "pressed" ? next.add(key) : next.delete(key); return next;
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
