import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseFeed } from '../apis/utils/rss.mjs';
import { NEWS_FEEDS, HUNGARIAN_SOURCES, feedBySource } from '../apis/utils/news-feeds.mjs';
import { fetchAllNews } from '../dashboard/inject.mjs';

test('parseFeed reads RSS, RDF and Atom and cuts every field', () => {
  const rss = '<rss><channel><item><title><![CDATA[Egy cím]]></title><link>https://a.example/1</link><pubDate>Wed, 07 Oct 2026 22:26:52 +0200</pubDate></item></channel></rss>';
  assert.deepEqual(parseFeed(rss), [{ title: 'Egy cím', link: 'https://a.example/1', date: 'Wed, 07 Oct 2026 22:26:52 +0200' }]);
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Atom &amp; co</title><link rel="alternate" href="https://b.example/2"/><updated>2026-10-07T12:00:00Z</updated></entry></feed>';
  assert.deepEqual(parseFeed(atom), [{ title: 'Atom & co', link: 'https://b.example/2', date: '2026-10-07T12:00:00Z' }]);
  const rdf = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>RDF item</title><link>https://c.example/3</link><dc:date>2026-10-07T10:00:00Z</dc:date></item></rdf:RDF>';
  assert.equal(parseFeed(rdf)[0].date, '2026-10-07T10:00:00Z');
  const long = `<rss><channel>${'<item><title>x</title></item>'.repeat(100)}</channel></rss>`;
  assert.equal(parseFeed(long).length, 40);
  assert.equal(parseFeed('<rss><channel><item><title>' + 'y'.repeat(5000) + '</title></item></channel></rss>')[0].title.length, 2000);
});

test('parseFeed never throws and falls back to the item pattern for a feed the parser refuses', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed(null), []);
  assert.deepEqual(parseFeed('not xml at all'), []);
  // A DOCTYPE is refused by the hardened parser; the headlines of the feed still come through.
  const odd = '<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel><item><title>Still here</title><link>https://d.example/4</link></item></channel></rss>';
  assert.equal(parseFeed(odd)[0].title, 'Still here');
});

test('the registry has unique https feeds with valid tiers, Hungarian sources and official sources', () => {
  const names = NEWS_FEEDS.map(feed => feed.source);
  assert.equal(new Set(names).size, names.length);
  for (const feed of NEWS_FEEDS) {
    assert.match(feed.url, /^https:\/\//, feed.source);
    assert.ok([1, 2, 3, 4].includes(feed.tier), feed.source);
    assert.match(feed.lang, /^[a-z]{2}$/);
  }
  assert.equal(HUNGARIAN_SOURCES.length, 7);
  assert.equal(feedBySource('Telex').lang, 'hu');
  assert.equal(feedBySource('Al Jazeera').state, true);
  assert.equal(feedBySource('Nope'), undefined);
});

test('fetchAllNews carries the tier, language and state flag and limits one busy feed', async t => {
  const items = Array.from({ length: 30 }, (_, index) => `<item><title>Ukraine story ${index}</title><pubDate>Wed, 07 Oct 2026 ${String(10 + (index % 10)).padStart(2, '0')}:00:00 GMT</pubDate></item>`).join('');
  const server = http.createServer((_req, res) => res.end(`<rss><channel>${items}</channel></rss>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const news = await fetchAllNews([[url, 'Telex']]);
  assert.ok(news.length > 0 && news.length <= 5, `one feed fills at most 5 slots, got ${news.length}`);
  assert.equal(news[0].tier, 2);
  assert.equal(news[0].lang, 'hu');
  const other = await fetchAllNews([[url, 'Al Jazeera']]);
  assert.equal(other[0].state, true);
  assert.equal(other[0].lang, undefined);
});
