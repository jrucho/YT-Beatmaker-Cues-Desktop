// Synthetic HTTP responses for the real youtubei.js parser. Self-contained so
// the WebView fixtures can also run it inside the native HTTP bridge.
export function catalogFixture({ url, body }) {
  if (!new URL(url).pathname.endsWith('/search')) return {};
  const request = JSON.parse(body);
  const playlistPage = /^fixture-playlists-([234])$/.exec(request.continuation ?? '');
  if (playlistPage || (request.query === 'samples' && request.context?.client?.clientName !== 'WEB_REMIX')) {
    const page = Number(playlistPage?.[1] ?? 1);
    const playlist = (i) => ({ playlistRenderer: {
      playlistId: `PLfixture000${i}`,
      title: { simpleText: `Sample picks ${i}` },
      shortBylineText: { simpleText: 'YouTube fixture' },
      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/fixture.jpg', width: 160, height: 90 }] },
    } });
    const items = (page === 1 ? [1, 2] : page === 2 ? [2, 3] : [page + 1]).map(playlist);
    const section = { itemSectionRenderer: { contents: items } };
    const continuation = { continuationItemRenderer: {
      trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
      continuationEndpoint: { continuationCommand: {
        token: `fixture-playlists-${page + 1}`,
        request: 'CONTINUATION_REQUEST_TYPE_SEARCH',
      } },
    } };
    if (page === 1) return { contents: { sectionListRenderer: { contents: [section, continuation] } } };
    const append = { appendContinuationItemsAction: { continuationItems: [...items, continuation] } };
    if (page === 2) return { onResponseReceivedCommands: [
      { reloadContinuationItemsCommand: { slot: 'RELOAD_CONTINUATION_SLOT_HEADER', continuationItems: [] } },
      append,
    ] };
    if (page === 3) return { onResponseReceivedActions: [append] };
    return { onResponseReceivedEndpoints: [
      { reloadContinuationItemsCommand: { slot: 'RELOAD_CONTINUATION_SLOT_BODY', continuationItems: items } },
    ] };
  }
  const match = /^fixture-(song|video|album)-([23])$/.exec(request.continuation ?? '');
  const filter = request.params ? atob(decodeURIComponent(request.params)).at(-2)?.charCodeAt(0) : 0;
  const kind = match?.[1] ?? ({ 8: 'song', 16: 'video', 24: 'album' }[filter]);
  if (!kind) return {};
  const p = Number(match?.[2] ?? 1);
  const numbers = request.query === 'no more' ? [5] : p === 1 ? [1, 2] : p === 2 ? [2, 3] : [4];
  const item = (i) => {
    const title = `Fixture ${kind} ${i}`;
    const id = `result${String(i).padStart(5, '0')}`;
    const navigationEndpoint = kind === 'album' ? {
      browseEndpoint: {
        browseId: `MPREfixture${i}`,
        browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } },
      },
    } : {
      watchEndpoint: {
        videoId: id,
        watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: kind === 'song' ? 'MUSIC_VIDEO_TYPE_ATV' : 'MUSIC_VIDEO_TYPE_OMV' } },
      },
    };
    const column = (run) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [run] } } });
    return { musicResponsiveListItemRenderer: {
      navigationEndpoint,
      playlistItemData: { videoId: id },
      flexColumns: [column({ text: title, navigationEndpoint }), column({ text: kind === 'album' ? '2024' : '2:05' })],
    } };
  };
  const shelf = { title: { runs: [{ text: kind }] }, contents: numbers.map(item) };
  if (p < 3 && request.query !== 'no more') shelf.continuations = [{ nextContinuationData: { continuation: `fixture-${kind}-${p + 1}` } }];
  if (p > 1) return { continuationContents: { musicShelfContinuation: shelf } };
  return { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: {
    selected: true, content: { sectionListRenderer: { contents: [{ musicShelfRenderer: shelf }] } },
  } }] } } };
}
