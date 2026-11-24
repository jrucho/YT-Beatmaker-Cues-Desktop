import { useEffect, useMemo, useState } from "react";
import { shuffled } from "../lib/format";
import type { Library, Track } from "../lib/types";

const SAMPLE_COUNT = 12;

/** New picks when opening or returning to the app; playback history never reshuffles the row. */
export function useLibrarySamples({ favorites, playlists }: Pick<Library, "favorites" | "playlists">) {
  const pool = useMemo(() => {
    const tracks = new Map<string, Track>();
    const add = (track: Track) => { if (!tracks.has(track.id)) tracks.set(track.id, track); };
    favorites.forEach(add);
    for (const playlist of playlists) playlist.tracks.forEach(add);
    return tracks;
  }, [favorites, playlists]);
  const [ids, setIds] = useState(() => shuffled([...pool.keys()]).slice(0, SAMPLE_COUNT));

  useEffect(() => {
    setIds(previous => {
      const kept = previous.filter(id => pool.has(id));
      const target = Math.min(SAMPLE_COUNT, pool.size);
      if (previous.length === target && kept.length === target) return previous;
      const known = new Set(kept);
      const candidates = [...pool.keys()].filter(id => !known.has(id));
      return [...kept, ...shuffled(candidates).slice(0, target - kept.length)];
    });
  }, [pool]);

  useEffect(() => {
    let wasHidden = document.hidden;
    const refresh = () => {
      if (wasHidden && !document.hidden) setIds(shuffled([...pool.keys()]).slice(0, SAMPLE_COUNT));
      wasHidden = document.hidden;
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [pool]);

  return useMemo(() => ids.flatMap(id => {
    const track = pool.get(id);
    return track ? [track] : [];
  }), [ids, pool]);
}
