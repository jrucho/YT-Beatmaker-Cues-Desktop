import { PlaylistIcon, RadioIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { NamePlaylistDialog } from "../components/Dialogs";
import { BackButton, EmptyState, PageHeader } from "../components/Page";
import { TrackList } from "../components/TrackList";
import { useTrackReveal } from "../hooks/useTrackReveal";
import { useT } from "../i18n";
import { paths } from "../lib/routes";
import type { Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";

const RADIO = { kind: "radio" } as const;

/** Radio is a live queue, not a saved Library playlist. Play using the original queue indices. */
export default function RadioPlaylist() {
  const t = useT();
  const navigate = useNavigate();
  const queue = usePlayer((s) => s.queue);
  const fromRadio = usePlayer((s) => s.source?.kind === "radio");
  const jumpTo = usePlayer((s) => s.jumpTo);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const [snapshot, setSnapshot] = useState<Track[] | null>(null);
  const [saving, setSaving] = useState(false);
  const { tracks, indices } = useMemo(() => {
    const indices = queue.flatMap((track, index) =>
      track.queueOrigin === "radio" || (fromRadio && !track.queueOrigin) ? [index] : [],
    );
    return { tracks: indices.map((index) => queue[index]), indices };
  }, [queue, fromRadio]);
  const reveal = useTrackReveal(tracks, { queueIndices: indices });

  const save = async (name: string) => {
    if (!snapshot) return;
    setSaving(true);
    try {
      const saved = await createPlaylist(name, snapshot);
      if (saved) {
        setSnapshot(null);
        navigate(paths.playlist(saved.id));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pb-8">
      <PageHeader title={t.libraryTools.radioPlaylist} actions={<BackButton fallback={paths.home} />} />
      {tracks.length ? (
        <div className="px-2 pt-2 md:px-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-3">
            <p className="text-sm text-fg-2">{t.common.tracks(tracks.length)}</p>
            <button type="button" onClick={() => setSnapshot(tracks)}
              className="flex min-h-11 items-center gap-2 rounded-full bg-accent-soft px-4 text-sm font-semibold text-accent-text hover:bg-surface-3">
              <PlaylistIcon size={18} aria-hidden="true" /> {t.album.saveAsPlaylist}
            </button>
          </div>
          <TrackList tracks={tracks} playbackSource={RADIO} onSelect={(index) => jumpTo(indices[index])} reveal={reveal} showAlbum={false} />
        </div>
      ) : (
        <EmptyState icon={<RadioIcon size={28} />} title={t.libraryTools.noRadioTitle} body={t.libraryTools.noRadioBody} />
      )}
      <NamePlaylistDialog open={!!snapshot} title={t.album.saveAsPlaylist}
        initial={snapshot ? `${t.libraryTools.radio} · ${snapshot[0].title}`.slice(0, 80) : ""}
        action={saving ? t.libraryTools.add.working : t.collection.save}
        onSubmit={save}
        onClose={() => { if (!saving) setSnapshot(null); }} />
    </div>
  );
}
