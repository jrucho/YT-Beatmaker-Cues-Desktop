import { Link } from "react-router";
import { usePlaybackCollection } from "../hooks/usePlaybackCollection";
import { useT } from "../i18n";
import { trackLinkState } from "../lib/routes";
import { isLocalAudio, type Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useUi } from "../stores/ui";

export function PlaybackContext({ track }: { track: Track }) {
  const t = useT();
  const collection = usePlaybackCollection();
  const index = usePlayer((s) => s.index);
  const closePanel = useUi((s) => s.closePanel);
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
      <span className="shrink-0">{isLocalAudio(track.id) ? t.libraryTools.localAudio : t.common.youtube}</span>
      {collection?.to ? (
        <><span aria-hidden="true">·</span>
          <Link to={collection.to} state={trackLinkState(track.id, index)} onClick={closePanel} className="min-w-0 truncate text-accent-text no-underline">
            {t.libraryTools.playingFrom(collection.name)}
          </Link>
        </>
      ) : collection ? <span className="truncate">· {t.libraryTools.playingFrom(collection.name)}</span> : null}
    </p>
  );
}
