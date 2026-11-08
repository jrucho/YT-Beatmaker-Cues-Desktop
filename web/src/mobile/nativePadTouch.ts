import { useLayoutEffect } from "react";
import type { PadSample } from "./padSamples";

interface Bounds { x: number; y: number; w: number; h: number }
interface Region extends Bounds { pad: number; sample: boolean; to: number }
interface PadMap { trackId: string | null; bank: string; aspect: number; width: number; height: number; dpr: number; pads: Region[]; blocked: Bounds[] }
export interface TouchReceipt { position: number; reconcile(trigger: () => void): void }
interface PadTouchBridge {
  configure(map: PadMap | null): void;
  take(bank: string, pad: number, sample: boolean, to: number, eventTime: number): TouchReceipt | Promise<TouchReceipt | undefined> | undefined;
}
declare global { interface Window { __pluginPadTouch?: PadTouchBridge } }

/** Native shells supply this adapter; other players retain their normal input path. */
export const takeNativePadTouch = (bank: string, pad: number, sample: boolean, to: number, eventTime: number) =>
  window.__pluginPadTouch?.take(bank, pad, sample, to ?? 0, eventTime);

export function useNativePadTouch(options: {
  trackId: string | null; bank: string; cues: Record<number, number>;
  samples: Record<string, PadSample>; disabled: boolean; padCount: number;
}) {
  const { trackId, bank, cues, samples, disabled, padCount } = options;
  useLayoutEffect(() => {
    const bridge = window.__pluginPadTouch;
    if (!bridge) return;
    let queued = false, disposed = false;
    const update = () => {
      queued = false;
      if (disposed) return;
      const grid = document.querySelector(".cue-pad-grid");
      if (disabled || document.hidden || !grid || Math.abs((window.visualViewport?.scale ?? 1) - 1) > .01 || document.querySelector('[role="dialog"],[aria-modal="true"]')) {
        bridge.configure(null);
        return;
      }
      const width = window.innerWidth, height = window.innerHeight;
      const bounds = (element: Element): Bounds => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
        return { x: left / width, y: top / height, w: Math.max(0, Math.min(width, rect.right) - left) / width, h: Math.max(0, Math.min(height, rect.bottom) - top) / height };
      };
      const pads: Region[] = [];
      grid.querySelectorAll<HTMLButtonElement>(".cue-pad").forEach((button, index) => {
        const pad = index + 1, sample = samples[`${bank}:${pad}`];
        if (pad > padCount || (!sample && cues[pad] == null)) return;
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (button.disabled || !hit || !button.contains(hit)) return;
        // The wrapper does not scale with pressed-pad feedback, so neighbouring
        // touches keep the same hit regions throughout a performance.
        pads.push({ ...bounds(button.parentElement!), pad: index, sample: !!sample, to: sample ? 0 : cues[pad] });
      });
      const blocked = Array.from(grid.querySelectorAll("button:not(.cue-pad)"), bounds);
      bridge.configure({ trackId, bank, aspect: width / height, width, height, dpr: window.devicePixelRatio || 1, pads, blocked });
    };
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(update); } };
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    const grid = document.querySelector(".cue-pad-grid");
    if (grid) resize.observe(grid);
    const changes = new MutationObserver(schedule);
    changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-modal"] });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("plugin-android-insets", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    update();
    return () => {
      disposed = true;
      resize.disconnect(); changes.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("plugin-android-insets", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      bridge.configure(null);
    };
  }, [trackId, bank, cues, samples, disabled, padCount]);
}
