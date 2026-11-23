import { isLocalAudio, type Library, type Track } from "../lib/types";
import { mediaInvoke } from "./mediaEditing";

interface LocalTrack extends Track {
  available: boolean;
  sourceTrackId?: string;
}

interface LocalAudioStatus {
  tracks: LocalTrack[];
}

export const localAudioStatus = () => mediaInvoke<LocalAudioStatus>("localAudioStatus");

export const pickPlaylistCover = (source: "photos" | "files") =>
  mediaInvoke<{ image: string; failed: boolean }>("pickPlaylistCover", source);

function libraryTracks(library: Library) {
  const unique = new Map<string, Track>();
  const add = (track: Track) => { if (!unique.has(track.id)) unique.set(track.id, track); };
  library.playlists.forEach((playlist) => playlist.tracks.forEach(add));
  library.favorites.forEach(add);
  library.history.forEach(add);
  return unique;
}

/** Includes retained audio even after its last playlist entry was removed. Never exposes sampler-only copies. */
export function libraryTrackChoices(library: Library, audio: LocalAudioStatus, destination: string) {
  const known = libraryTracks(library);
  const existing = new Set(library.playlists.find((p) => p.id === destination)?.tracks.map((track) => track.id));
  const available = new Map(audio.tracks.filter((track) => track.available).map((track) => [track.id, track]));
  for (const track of available.values()) if (!track.sourceTrackId || known.has(track.id)) known.set(track.id, track);
  const tracks = [...known.values()].filter((track) => !existing.has(track.id) &&
    (!isLocalAudio(track.id) || available.has(track.id)));
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const playlists = library.playlists.filter((p) => p.id !== destination).map((playlist) => ({
    playlist,
    tracks: playlist.tracks.flatMap((track) => {
      const choice = byId.get(track.id);
      return choice ? [choice] : [];
    }),
  }));
  return { tracks, playlists };
}
