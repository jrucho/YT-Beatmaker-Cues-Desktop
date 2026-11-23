// Run with: node --import ./server/node_modules/tsx/dist/loader.mjs scripts/check-catalog-search.mjs
import assert from 'node:assert/strict';
import { searchAlbumsPage } from '../server/src/browse.ts';
import { config } from '../server/src/config.ts';
import { searchTracksPage } from '../server/src/search.ts';
import { catalogFixture } from '../plugin/Tests/fixtures/catalog-search.mjs';

let continuationRequests = 0;
let failNext = false;
config.fetch = async (input, init) => {
  const url = (typeof input === 'string' || input instanceof URL) ? String(input) : input.url;
  const body = init?.body;
  if (url.includes('/search') && JSON.parse(body).continuation) {
    continuationRequests++;
    if (failNext) {
      failNext = false;
      throw new Error('fixture network error');
    }
  }
  return Response.json(catalogFixture({ url, body }));
};

for (const kind of ['song', 'video', 'album']) {
  const find = (q, lang = 'en', cursor) => kind === 'album' ? searchAlbumsPage(q, lang, cursor) : searchTracksPage(q, kind, lang, cursor);
  const first = await find('fixture');
  const titles = (page) => page.items.map((item) => item.title);
  const want = (...n) => n.map(i => `Fixture ${kind} ${i}`);
  assert.deepEqual(titles(first), want(1, 2));
  assert(first.cursor);
  await assert.rejects(find('different query', 'en', first.cursor), { status: 410 });
  await assert.rejects(find('fixture', 'fr', first.cursor), { status: 410 });
  const wrongKind = kind === 'album' ? searchTracksPage('fixture', 'song', 'en', first.cursor) : searchAlbumsPage('fixture', 'en', first.cursor);
  await assert.rejects(wrongKind, { status: 410 });

  failNext = true;
  await assert.rejects(find('fixture', 'en', first.cursor), /fixture network error/);
  const count = continuationRequests;
  const [second, replay] = await Promise.all([find('fixture', 'en', first.cursor), find('fixture', 'en', first.cursor)]);
  assert.deepEqual(titles(second), want(2, 3));
  assert(second.cursor);
  assert.notEqual(second.cursor, first.cursor);
  assert.deepEqual(replay, second);
  assert.equal(continuationRequests, count + 1, 'Concurrent retries must share exactly one continuation request');
  const third = await find('fixture', 'en', second.cursor);
  assert.deepEqual(titles(third), want(4));
  assert.equal(third.cursor, undefined);
  assert.equal((await find('no more')).cursor, undefined);
}
console.log('PASS: Songs, Videos and Albums paginate through the real YouTube Music parser, with cursor isolation, retry, and last-page detection.');
