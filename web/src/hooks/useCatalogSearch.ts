import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api, ApiError, type CatalogSearchPage } from "../lib/api";
import type { AlbumCard, Track } from "../lib/types";

type Kind = "song" | "video" | "album";
type Results =
  | ({ kind: "album" } & CatalogSearchPage<AlbumCard>)
  | ({ kind: "song" | "video" } & CatalogSearchPage<Track>);
type SearchState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; page: Results; loadingMore?: boolean; moreError?: string; expired?: boolean };

function append<T extends { id: string }>(before: T[], after: T[]) {
  const seen = new Set(before.map((item) => item.id));
  const added = after.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return added.length ? [...before, ...added] : before;
}

function mergePage(page: Results, previous?: Results): Results {
  if (page.kind === "album") {
    return { ...page, items: append(previous?.kind === "album" ? previous.items : [], page.items) };
  }
  return { ...page, items: append(previous && previous.kind !== "album" ? previous.items : [], page.items) };
}

async function fetchPage(q: string, kind: Kind, signal: AbortSignal, paged: boolean, cursor?: string): Promise<Results> {
  if (kind === "album") {
    const page = paged ? await api.searchAlbumsPage(q, signal, cursor) : { items: await api.searchAlbums(q, signal) };
    return { kind, ...page };
  }
  const page = paged ? await api.searchTracksPage(q, kind, signal, cursor) : { items: await api.search(q, kind, signal) };
  return { kind, ...page };
}

export function useCatalogSearch(q: string, kind: Kind, paged: boolean) {
  const lang = useI18n((s) => s.lang);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([q, kind, lang, retry, paged]);
  const [result, setResult] = useState<{ key: string; state: SearchState }>();
  const active = useRef<{ key: string; controller: AbortController; loadingMore: boolean } | null>(null);
  const state: SearchState = !q ? { status: "idle" } : result?.key === key ? result.state : { status: "loading" };

  useEffect(() => {
    if (!q) return;
    const session = { key, controller: new AbortController(), loadingMore: false };
    active.current = session;
    setResult({ key, state: { status: "loading" } });
    const signal = session.controller.signal;
    void fetchPage(q, kind, signal, paged).then((page) => {
      if (!signal.aborted) setResult({ key, state: { status: "ok", page: paged ? mergePage(page) : page } });
    }).catch((error: Error) => {
      if (!signal.aborted) setResult({ key, state: { status: "error", message: error.message } });
    });
    return () => { session.controller.abort(); active.current = null; };
  }, [key, q, kind, paged]);

  const loadMore = async () => {
    const session = active.current;
    if (!session || session.key !== key || session.loadingMore || state.status !== "ok" || !state.page.cursor || state.expired) return;
    const previous = state.page;
    session.loadingMore = true;
    setResult({ key, state: { status: "ok", page: previous, loadingMore: true } });
    try {
      const page = await fetchPage(q, kind, session.controller.signal, true, previous.cursor);
      if (session.controller.signal.aborted) return;
      setResult({ key, state: { status: "ok", page: mergePage(page, previous) } });
    } catch (error) {
      if (!session.controller.signal.aborted) setResult({ key, state: {
        status: "ok", page: previous, moreError: (error as Error).message,
        expired: error instanceof ApiError && error.status === 410,
      } });
    } finally {
      session.loadingMore = false;
    }
  };

  return { state, loadMore, retry: () => setRetry((n) => n + 1) };
}
