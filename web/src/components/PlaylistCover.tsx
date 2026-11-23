import { FileImageIcon, ImagesIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useT } from "../i18n";
import type { Playlist } from "../lib/types";
import { pickPlaylistCover } from "../mobile/libraryTools";
import { useLibrary } from "../stores/library";
import { Cover } from "./Cover";
import { Modal } from "./Modal";

export function PlaylistCover({ playlist, className }: { playlist: Playlist; className: string }) {
  const t = useT();
  const labels = t.libraryTools.cover;
  const setPlaylistCover = useLibrary((s) => s.setPlaylistCover);
  const working = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function edit(source: "photos" | "files" | "remove") {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (source === "remove") await setPlaylistCover(playlist.id, null);
      else {
        const { image, failed } = await pickPlaylistCover(source);
        if (failed) {
          setError(labels.invalidImage);
          return;
        }
        if (image) await setPlaylistCover(playlist.id, image);
      }
      setOpen(false);
    } catch (e) {
      setError((e as Error).message || labels.unavailable);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const action = "flex min-h-11 items-center gap-2 rounded-xl bg-surface-3 px-3 py-2 text-left text-sm font-medium disabled:opacity-40";
  return (
    <>
      <button type="button" className="playlist-cover-edit relative shrink-0 rounded-[18px] focus-visible:outline-offset-4"
        aria-label={labels.edit} title={labels.edit} onClick={() => { setError(""); setOpen(true); }}>
        <Cover kind="playlist" tracks={playlist.tracks} cover={playlist.cover} className={className} iconSize={64} />
        <span className="pointer-events-none absolute right-1.5 bottom-1.5 grid size-7 place-items-center rounded-full bg-black/75 text-white">
          <PencilSimpleIcon size={15} weight="bold" aria-hidden="true" />
        </span>
      </button>
      <Modal open={open} onClose={() => { if (!working.current) setOpen(false); }} title={labels.edit}>
        <div className="flex flex-col gap-2">
          <button type="button" className={action} disabled={busy} onClick={() => void edit("photos")}>
            <ImagesIcon size={18} aria-hidden="true" /> {labels.photos}
          </button>
          <button type="button" className={action} disabled={busy} onClick={() => void edit("files")}>
            <FileImageIcon size={18} aria-hidden="true" /> {labels.files}
          </button>
          {playlist.cover && <button type="button" className={action} disabled={busy} onClick={() => void edit("remove")}>{labels.remove}</button>}
          {busy && <p role="status" className="text-sm text-fg-2">{t.libraryTools.add.working}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
