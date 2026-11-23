import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Link, useLocation, useNavigate, useNavigationType } from "react-router";
import { Cover, type CoverKind } from "../components/Cover";
import { NamePlaylistDialog } from "../components/Dialogs";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/Page";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { paths, type LibraryReturnState } from "../lib/routes";
import { centerInScrollArea } from "../lib/scroll";
import type { Playlist, Track } from "../lib/types";
import { nativeLibraryToolsEnabled } from "../native/host";
import { selectPlayingPlaylistId, usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";
import { useUi } from "../stores/ui";

function Entry({ to, name, kind, tracks, cover, sub, playingLabel, cardRef, onDelete, deleteLabel }: { to: string; name: string; kind: CoverKind; tracks: Track[]; cover?: string; sub: string; playingLabel?: string; cardRef?: Ref<HTMLLIElement>; onDelete?: () => void; deleteLabel?: string }) {
  return (
    <li ref={cardRef} className="group relative">
      <Link
        to={to}
        className="group flex items-center gap-3 rounded-[16px] p-2 transition-colors hover:bg-surface-2 md:flex-col md:items-stretch md:gap-3 md:p-3"
      >
        <Cover
          kind={kind}
          tracks={tracks}
          cover={cover}
          iconSize={26}
          className="size-16 shrink-0 rounded-[12px] md:aspect-square md:size-auto md:w-full md:rounded-[14px] md:shadow-[0_12px_32px_rgb(0_0_0/0.3)]"
        />
        <span className={onDelete ? "min-w-0 pr-9 md:pr-0" : "min-w-0"}>
          <span className={cn("block truncate font-medium", playingLabel && "text-accent-text")}>{name}</span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm text-fg-2">{sub}</span>
            {playingLabel && (
              <span className="playlist-playing-label shrink-0 text-xs font-semibold whitespace-nowrap text-accent-text">{playingLabel}</span>
            )}
          </span>
        </span>
      </Link>
      {onDelete && (
        <button
          type="button"
          aria-label={deleteLabel}
          onClick={onDelete}
          className="absolute top-1.5 right-1.5 grid size-9 place-items-center rounded-full bg-bg/75 text-fg-2 backdrop-blur-sm transition-colors hover:text-danger active:scale-90 md:top-4 md:right-4"
        >
          <TrashIcon size={16} />
        </button>
      )}
    </li>
  );
}

export default function Library() {
  const { favorites, playlists, history, createPlaylist, deletePlaylist } = useLibrary();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Playlist | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const t = useT();
  const libraryTools = nativeLibraryToolsEnabled();
  const playingPlaylistId = usePlayer((s) => libraryTools ? selectPlayingPlaylistId(s) : null);
  const revealedId = libraryTools && navigationType !== "POP"
    ? (location.state as LibraryReturnState | null)?.revealPlaylistId
    : undefined;
  const hasReturnCard = !!revealedId && playlists.some((p) => p.id === revealedId);
  const returnCard = useRef<HTMLLIElement>(null);

  useLayoutEffect(() => {
    if (!hasReturnCard) return;
    // Wait for the parent route's scroll reset before revealing the card in the same list position.
    const frame = requestAnimationFrame(() => {
      if (returnCard.current) centerInScrollArea(returnCard.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [hasReturnCard, revealedId, location.key]);

  // Reaching the playlists menu (the back button, the rail) means "show me the library", not "reopen my playlist".
  useEffect(() => {
    useUi.getState().setLastPlaylist(null);
  }, []);

  return (
    <div className="pb-8">
      <PageHeader
        title={t.nav.library}
        actions={
          <>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex h-10 items-center gap-1.5 rounded-full bg-accent pr-4 pl-3 text-sm font-semibold text-accent-ink transition-transform active:scale-[0.97]"
          >
            <PlusIcon size={18} weight="bold" /> <span className="hidden sm:inline">{t.nav.newPlaylist}</span>
            <span className="sm:hidden">{t.library.newShort}</span>
          </button>
          </>
        }
      />

      <ul className="grid grid-cols-1 gap-1 px-2 pt-2 md:grid-cols-3 md:gap-2 md:px-4 lg:grid-cols-4 2xl:grid-cols-6">
        <Entry to={paths.favorites} name={t.nav.favorites} kind="favorites" tracks={favorites} sub={t.common.tracks(favorites.length)} />
        <Entry to={paths.history} name={t.nav.recentlyPlayed} kind="history" tracks={history} sub={t.common.tracks(history.length)} />
        {playlists.map((p) => {
          const playing = playingPlaylistId === p.id;
          return (
            <Entry
              key={p.id}
              to={paths.playlist(p.id)}
              name={p.name}
              kind="playlist"
              tracks={p.tracks}
              cover={p.cover}
              sub={playing ? t.common.tracks(p.tracks.length) : t.library.playlistSub(p.tracks.length)}
              playingLabel={playing ? t.nowPlaying.tabPlaying : undefined}
              cardRef={p.id === revealedId ? returnCard : undefined}
              onDelete={() => setPending(p)}
              deleteLabel={`${t.collection.deletePlaylist}: ${p.name}`}
            />
          );
        })}
      </ul>

      {playlists.length === 0 && (
        <p className="px-4 pt-6 text-sm text-fg-2 md:px-6">
          {t.library.noPlaylists}
        </p>
      )}

      <NamePlaylistDialog
        open={creating}
        title={t.nav.newPlaylist}
        action={t.library.create}
        onClose={() => setCreating(false)}
        onSubmit={async (name) => {
          const p = await createPlaylist(name);
          setCreating(false);
          if (p) navigate(paths.playlist(p.id));
        }}
      />

      <Modal open={!!pending} onClose={() => setPending(null)} title={t.collection.deleteTitle}>
        <p className="text-sm text-fg-2">{pending ? (libraryTools
          ? t.libraryTools.deletePlaylist(pending.name) : t.collection.deleteBody(pending.name, pending.tracks.length)) : ""}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setPending(null)} className="h-11 rounded-full px-5 text-sm font-medium text-fg-2 hover:text-fg">
            {t.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => {
              if (pending) void deletePlaylist(pending.id);
              setPending(null);
            }}
            className="h-11 rounded-full bg-danger px-6 text-sm font-semibold text-white"
          >
            {t.collection.delete}
          </button>
        </div>
      </Modal>
    </div>
  );
}
