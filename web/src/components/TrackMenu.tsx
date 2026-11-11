import {
  ArrowSquareOutIcon,
  HeartIcon,
  ListPlusIcon,
  PlayIcon,
  PlaylistIcon,
  QueueIcon,
  RadioIcon,
  TrashIcon,
  DownloadSimpleIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MD, useMediaQuery } from "../hooks/useMediaQuery";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";
import { toast, useUi } from "../stores/ui";
import { Artwork } from "./Artwork";
import { iosPadLayoutEnabled } from '../mobile/padLayout';
import { renameLocalAudio, shareLocalAudio } from '../mobile/mediaEditing';
import type { Track } from '../lib/types';
import { Modal } from './Modal';

function Item({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] transition-colors md:py-2 md:text-sm",
        "hover:bg-surface-3 focus-visible:bg-surface-3",
        danger ? "text-danger" : "text-fg",
      )}
    >
      <span className={cn("shrink-0", danger ? "text-danger" : "text-fg-2")}>{icon}</span>
      {children}
    </button>
  );
}

export function TrackMenu() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);
  const openAddToPlaylist = useUi((s) => s.openAddToPlaylist);
  const isFavorite = useLibrary((s) => (menu ? s.favorites.some((t) => t.id === menu.track.id) : false));
  const inLibrary = useLibrary((s) =>
    menu
      ? s.favorites.some((t) => t.id === menu.track.id) ||
        s.history.some((t) => t.id === menu.track.id) ||
        s.playlists.some((p) => p.tracks.some((t) => t.id === menu.track.id))
      : false,
  );
  const isMd = useMediaQuery(MD);
  const box = useRef<HTMLDivElement>(null);
  const t = useT();
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [renaming,setRenaming]=useState<Track|null>(null),[songName,setSongName]=useState(''),[savingName,setSavingName]=useState(false);

  useLayoutEffect(() => {
    if (!menu || !isMd || !box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    setPos({
      left: Math.min(menu.x, window.innerWidth - width - 12),
      top: menu.y + height > window.innerHeight - 12 ? Math.max(12, menu.y - height) : menu.y,
    });
  }, [menu, isMd]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);

  const run = (fn: () => void) => () => {
    fn();
    close();
  };
  const youtubeTrack=!!menu&&!menu.track.id.startsWith('loc')&&/^[A-Za-z0-9_-]{11}$/.test(menu.track.id);

  const content = menu && (
    <div role="menu" aria-label={t.trackMenu.actionsFor(menu.track.title)} data-escape-closes className="flex flex-col">
      <Item icon={<PlayIcon size={18} />} onClick={run(() => usePlayer.getState().playTrack(menu.track))}>
        {t.trackMenu.playNow}
      </Item>
      <Item icon={<QueueIcon size={18} />} onClick={run(() => usePlayer.getState().playNext(menu.track))}>
        {t.trackMenu.playNext}
      </Item>
      <Item icon={<ListPlusIcon size={18} />} onClick={run(() => usePlayer.getState().addToQueue(menu.track))}>
        {t.trackMenu.addToQueue}
      </Item>
      <Item icon={<RadioIcon size={18} />} onClick={run(() => void usePlayer.getState().startRadio(menu.track))}>
        {t.trackMenu.startRadio}
      </Item>
      <div className="mx-3 my-1 h-px bg-line" />
      <Item
        icon={<HeartIcon size={18} weight={isFavorite ? "fill" : "regular"} className={isFavorite ? "text-accent-text" : ""} />}
        onClick={run(() => void useLibrary.getState().toggleFavorite(menu.track))}
      >
        {isFavorite ? t.common.removeFromFavorites : t.common.addToFavorites}
      </Item>
      <Item icon={<PlaylistIcon size={18} />} onClick={() => openAddToPlaylist([menu.track])}>
        {t.trackMenu.addToPlaylist}
      </Item>
      {iosPadLayoutEnabled()&&menu.track.id.startsWith('loc')&&<Item icon={<DownloadSimpleIcon size={18}/>} onClick={run(()=>{void shareLocalAudio(menu.track).catch(error=>toast(error.message,'error'));})}>Download / Share audio</Item>}
      {iosPadLayoutEnabled()&&menu.track.id.startsWith('loc')&&<Item icon={<PencilSimpleIcon size={18}/>} onClick={run(()=>{setRenaming(menu.track);setSongName(menu.track.title);})}>Rename song</Item>}
      {menu.playlistId && (
        <Item
          danger
          icon={<TrashIcon size={18} />}
          onClick={run(() => void useLibrary.getState().removeFromPlaylist(menu.playlistId!, menu.track.id))}
        >
          {t.trackMenu.removeFromPlaylist}
        </Item>
      )}
      {inLibrary && (
        <Item danger icon={<TrashIcon size={18} />} onClick={run(() => void useLibrary.getState().removeTrack(menu.track.id))}>
          {iosPadLayoutEnabled()&&menu.track.id.startsWith('loc')?'Delete audio from library':t.trackMenu.removeFromLibrary}
        </Item>
      )}
      {youtubeTrack&&<><div className="mx-3 my-1 h-px bg-line" />
      <Item
        icon={<ArrowSquareOutIcon size={18} />}
        onClick={run(() => window.open(`https://www.youtube.com/watch?v=${menu.track.id}`, "_blank", "noopener"))}
      >
        {t.trackMenu.openYoutube}
      </Item></>}
    </div>
  );

  return <>{createPortal(
    <AnimatePresence>
      {menu && (
        <div className="fixed inset-0 z-50" onContextMenu={(e) => e.preventDefault()}>
          <motion.div
            className={cn("absolute inset-0", isMd ? "bg-transparent" : "bg-scrim")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
          {isMd ? (
            <motion.div
              ref={box}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              style={pos}
              className="absolute w-64 origin-top-left rounded-2xl border border-line-strong bg-surface-2 p-1.5 shadow-[0_16px_48px_rgb(0_0_0/0.45)]"
            >
              {content}
            </motion.div>
          ) : (
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
              className="island safe-bottom absolute inset-x-0 bottom-0 rounded-b-none"
            >
              <div className="island-core p-2">
                <div className="mx-auto mt-1 mb-2 h-1 w-9 rounded-full bg-surface-4" />
                <div className="flex items-center gap-3 px-3 pb-3">
                  <Artwork src={menu.track.thumb} className="size-12 rounded-[10px]" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{menu.track.title}</p>
                    <p className="truncate text-sm text-fg-2">{menu.track.artist}</p>
                  </div>
                </div>
                <div className="mx-3 mb-1 h-px bg-line" />
                {content}
              </div>
            </motion.div>
          )}
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )}<Modal open={!!renaming} onClose={()=>{if(!savingName)setRenaming(null);}} title="Rename song">
    <form className="flex flex-col gap-3" onSubmit={event=>{event.preventDefault();if(!renaming||savingName||!songName.trim())return;setSavingName(true);void renameLocalAudio(renaming,songName).then(()=>setRenaming(null)).catch(error=>toast(error.message,'error')).finally(()=>setSavingName(false));}}>
      <label htmlFor="song-name" className="text-sm text-fg-2">Song name</label>
      <input id="song-name" autoFocus value={songName} maxLength={200} disabled={savingName} onChange={event=>setSongName(event.target.value)} className="h-12 rounded-full border border-line-strong bg-surface-1 px-5 text-[15px] focus:border-accent focus:outline-none"/>
      <div className="flex justify-end gap-2"><button type="button" disabled={savingName} onClick={()=>setRenaming(null)} className="h-11 rounded-full px-5 text-sm text-fg-2">{t.common.cancel}</button><button type="submit" disabled={savingName||!songName.trim()} className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink disabled:opacity-40">{savingName?'Saving…':t.collection.save}</button></div>
    </form>
  </Modal></>;
}
