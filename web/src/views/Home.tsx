import { ClockCounterClockwiseIcon, HeartIcon, MagnifyingGlassIcon, PlayIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Artwork } from "../components/Artwork";
import { LogoMark } from "../components/Brand";
import { PageHeader, Section } from "../components/Page";
import { TrackList, TrackListSkeleton } from "../components/TrackList";
import { ViewModeToggle } from "../components/ViewModeToggle";
import { MD, useMediaQuery } from "../hooks/useMediaQuery";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { paths } from "../lib/routes";
import type { Track } from "../lib/types";
import { nativeLibraryToolsEnabled } from "../native/host";
import { usePlayer, type PlaybackSource } from "../player/player";
import { useAppearance } from "../stores/appearance";
import { useLibrary } from "../stores/library";

const FAVORITES = { kind: "favorites" } as const;
const HISTORY = { kind: "history" } as const;

function Shortcut({ to, label, tracks, cover, source }: { to: string; label: string; tracks: Track[]; cover: ReactNode; source: PlaybackSource }) {
  const playList = usePlayer((s) => s.playList);
  const t = useT();
  return (
    <div className="home-shortcut group relative flex h-14 items-center gap-3 overflow-hidden rounded-[12px] bg-surface-2 pr-2 transition-colors hover:bg-surface-3 md:h-16">
      <Link to={to} className="absolute inset-0" aria-label={label} />
      <span className="home-shortcut-art pointer-events-none size-14 shrink-0 overflow-hidden md:size-16">{cover}</span>
      <span className="pointer-events-none min-w-0 flex-1 truncate text-[13px] font-semibold md:text-sm">{label}</span>
      {tracks.length > 0 && (
        <button
          type="button"
          onClick={() => playList(tracks, 0, source)}
          aria-label={t.common.playX(label)}
          className="relative z-10 hidden size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-[0_6px_18px_rgb(0_0_0/0.35)] transition-[opacity,transform] duration-200 ease-out-expo group-hover:opacity-100 hover:scale-105 active:scale-95 md:grid"
        >
          <PlayIcon size={18} weight="fill" />
        </button>
      )}
    </div>
  );
}

function RecentCard({ track, onPlay }: { track: Track; onPlay: () => void }) {
  const t=useT();
  return (
    <button type="button" onClick={onPlay} aria-label={t.common.playX(track.title)} className="recent-track-card group flex w-36 min-w-0 max-w-36 shrink-0 snap-start flex-col gap-2 text-left md:w-44 md:max-w-44">
      <span className="relative block aspect-square w-full shrink-0">
        <Artwork src={track.art} fallback={track.thumb} className="absolute inset-0 size-full rounded-[14px]" />
        <span className="absolute right-2 bottom-2 grid size-11 translate-y-1 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-[opacity,transform] duration-200 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100">
          <PlayIcon size={20} weight="fill" />
        </span>
      </span>
      <span className="recent-track-caption flex w-full min-w-0 flex-col gap-1">
        <span title={track.title} className="recent-track-title line-clamp-2 min-h-10 break-words text-sm leading-5 font-medium">{track.title}</span>
        <span title={track.artist} className="block truncate text-xs text-fg-2">{track.artist}</span>
      </span>
    </button>
  );
}

export default function Home() {
  const { favorites, playlists, history, status } = useLibrary();
  const playList = usePlayer((s) => s.playList);
  const navigate = useNavigate();
  const t = useT();
  const show = useAppearance();
  const wide = useMediaQuery(MD);
  // Reserve a fourth shortcut row for tall phone layouts, leaving room for
  // the full-sized Recently Played caption and the mini-player.
  const tall = useMediaQuery("(min-height: 900px)");
  const compact = nativeLibraryToolsEnabled() && !wide;
  const empty = status === "ready" && !favorites.length && !playlists.length && !history.length;

  return (
    <div className={cn("pb-8", compact && "native-mobile-home")}>
      <PageHeader />

      <div className="home-greeting px-4 pt-2 pb-6 md:px-6 md:pt-8">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight md:text-4xl">{t.time.greeting(new Date().getHours())}</h1>
      </div>

      {status === "loading" && <TrackListSkeleton rows={6} />}

      {empty && (
        <div className="mx-4 flex flex-col items-start gap-5 rounded-[20px] bg-surface-2 p-6 ring-1 ring-line md:mx-6 md:flex-row md:items-center md:p-8">
          <span className="grid size-16 shrink-0 place-items-center rounded-[18px] bg-accent text-accent-ink">
            <LogoMark className="size-10" />
          </span>
          <div className="flex-1">
            <p className="text-xl font-semibold tracking-tight">{t.home.startTitle}</p>
            <p className="mt-1 max-w-[52ch] text-sm text-fg-2">{t.home.startBody}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(paths.search)}
            className="flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-semibold text-accent-ink transition-transform active:scale-[0.97]"
          >
            <MagnifyingGlassIcon size={20} weight="bold" /> {t.common.searchMusic}
          </button>
        </div>
      )}

      {!empty && status === "ready" && (
        <div className="home-sections flex flex-col gap-10">
          {show.homeShortcuts && <div className="home-shortcuts grid grid-cols-2 gap-2 px-4 md:px-6 lg:grid-cols-3 2xl:grid-cols-4">
            <Shortcut
              to={paths.favorites}
              label={t.nav.favorites}
              tracks={favorites}
              source={FAVORITES}
              cover={
                <span className="grid size-full place-items-center bg-accent-soft text-accent-text">
                  <HeartIcon size={24} weight="fill" />
                </span>
              }
            />
            <Shortcut
              to={paths.history}
              label={t.nav.recentlyPlayed}
              tracks={history}
              source={HISTORY}
              cover={
                <span className="grid size-full place-items-center bg-surface-3 text-fg-2">
                  <ClockCounterClockwiseIcon size={24} />
                </span>
              }
            />
            {playlists.slice(0, compact && !tall ? 4 : 6).map((p) => (
              <Shortcut
                key={p.id}
                to={paths.playlist(p.id)}
                label={p.name}
                tracks={p.tracks}
                source={{ kind: "playlist", id: p.id }}
                cover={<Artwork src={p.cover || p.tracks[0]?.thumb} fallback={(p.cover && p.tracks[0]?.thumb) || p.tracks[0]?.art} className="size-full" />}
              />
            ))}
          </div>}

          {show.homeRecent && history.length > 0 && (
            <Section
              className="home-recent"
              title={t.nav.recentlyPlayed}
              action={
                <div className="flex shrink-0 items-center gap-3"><ViewModeToggle value={show.recentView} onChange={recentView=>show.set({recentView})} label={t.nav.recentlyPlayed}/><Link to={paths.history} className="text-sm font-medium text-fg-2 hover:text-fg">
                  {t.home.seeAll}
                </Link></div>
              }
            >
              {show.recentView==='list'?<div className="recent-track-list px-2 md:px-3"><TrackList tracks={history.slice(0,16)} context={history} playbackSource={HISTORY} header={false} showAlbum={false}/></div>:<div className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 md:scroll-px-6 md:px-6">
                {history.slice(0, 16).map((t, i) => (
                  <RecentCard key={t.id} track={t} onPlay={() => playList(history, i, HISTORY)} />
                ))}
              </div>}
            </Section>
          )}

          {show.homeFavorites && favorites.length > 0 && (
            <Section
              title={t.home.yourFavorites}
              action={
                <Link to={paths.favorites} className="text-sm font-medium text-fg-2 hover:text-fg">
                  {t.home.seeAll}
                </Link>
              }
            >
              <div className="px-2 md:px-3">
                <TrackList tracks={favorites.slice(0, 5)} context={favorites} playbackSource={FAVORITES} header={false} showAlbum={false} />
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
