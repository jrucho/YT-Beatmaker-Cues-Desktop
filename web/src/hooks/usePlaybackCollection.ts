import { useMemo } from "react";
import { useT } from "../i18n";
import { paths } from "../lib/routes";
import { selectPlaybackSource, usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";

/** Use the actual source, never a different playlist that happens to contain the same track. */
export function usePlaybackCollection(): { name: string; to?: string } | null {
  const t = useT();
  const source = usePlayer(selectPlaybackSource);
  const playlist = useLibrary((s) => source?.kind === "playlist" ? s.playlists.find((p) => p.id === source.id) : undefined);
  if (playlist) return { name: playlist.name, to: paths.playlist(playlist.id) };
  if (source?.kind === "radio") return { name: t.libraryTools.radio, to: paths.radio };
  if (source?.kind === "favorites") return { name: t.nav.favorites };
  if (source?.kind === "history") return { name: t.nav.recentlyPlayed };
  return null;
}

/** Resolve old saved queues that have no source metadata, without guessing between duplicates. */
export function useMatchingPlaylists(trackId?: string) {
  const playlists = useLibrary((s) => trackId ? s.playlists : undefined);
  const queue = usePlayer((s) => trackId ? (s.original ?? s.queue) : undefined);
  return useMemo(() => {
    if (!trackId || !playlists) return [];
    const matching = playlists.filter((p) => p.tracks.some((track) => track.id === trackId));
    if (matching.length <= 1 || !queue?.length) return matching;
    const exact = matching.filter((p) => p.tracks.length === queue.length
      && p.tracks.every((track, i) => track.id === queue[i].id));
    if (exact.length) return exact;

    // An older saved queue might have been shuffled without an original order.
    const ids = new Set(queue.map((track) => track.id));
    if (ids.size === queue.length) {
      const shuffled = matching.filter((p) => p.tracks.length === ids.size && p.tracks.every((track) => ids.has(track.id)));
      if (shuffled.length) return shuffled;
    }
    return matching;
  }, [playlists, queue, trackId]);
}
