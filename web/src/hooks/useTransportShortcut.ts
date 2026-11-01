import { useEffect } from "react";
import { usePlayer } from "../player/player";
import { playerShortcutsEnabled } from "../native/host";
import { useUi } from "../stores/ui";
import { isTvMode } from "../tv/tvMode";

/** One Space transport handler across Discover, Studio and the music/cue views. */
export function useTransportShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== " " && event.code !== "Space") || !playerShortcutsEnabled() || isTvMode()) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.composedPath()[0] ?? event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea,select,input:not([type="range"]),[role="textbox"],[role="combobox"]'))) return;
      const ui = useUi.getState();
      if (ui.menu || ui.addToPlaylist || document.querySelector('[role="dialog"],[aria-modal="true"]')) return;
      const player = usePlayer.getState();
      if (!player.queue.length) return;
      // A focused pad/button must not activate a second action on key-up, and
      // the original studio engine must not toggle the same key a second time.
      event.preventDefault();event.stopImmediatePropagation();
      if (!event.repeat) player.toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
