import { useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";
import type { TrackLinkState } from "../lib/routes";
import type { Track } from "../lib/types";
import { selectCurrent, selectPlayingPlaylistId, usePlayer } from "../player/player";

interface Options {
  queueIndices?: number[];
  playlistId?: string;
}

export function useTrackReveal(tracks: Track[], { queueIndices, playlistId }: Options = {}) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const explicit = (location.state as Partial<TrackLinkState> | null)?.revealTrack;
  const previousPath = useRef<string>(undefined);
  const [entry, setEntry] = useState<{ key: string; target: TrackLinkState["revealTrack"] }>();

  useLayoutEffect(() => {
    // Snapshot the song once on entry, not on a later song change or on opening the Now Playing sheet.
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    const player = usePlayer.getState();
    const track = playlistId && !explicit && navigationType !== "POP" && selectPlayingPlaylistId(player) === playlistId
      ? selectCurrent(player) : null;
    setEntry(track ? { key: location.key, target: { id: track.id, queueIndex: player.index } } : undefined);
  }, [explicit, location.key, location.pathname, navigationType, playlistId]);

  // Back/Forward should keep the user's previously scrolled position.
  if (navigationType === "POP") return undefined;
  const target = explicit ?? (entry?.key === location.key ? entry.target : undefined);
  if (!target) return undefined;
  const hint = queueIndices ? queueIndices.indexOf(target.queueIndex) : target.queueIndex;
  const index = tracks[hint]?.id === target.id ? hint : tracks.findIndex((track) => track.id === target.id);
  return index < 0 ? undefined : { key: location.key, index };
}
