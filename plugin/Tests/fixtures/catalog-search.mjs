// Synthetic HTTP responses for the real youtubei.js parser. Self-contained so
// the WebView fixtures can also run it inside the native HTTP bridge.
export function catalogFixture({ url, body }) {
  if (!new URL(url).pathname.endsWith('/search')) return {};
  const request = JSON.parse(body);
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
