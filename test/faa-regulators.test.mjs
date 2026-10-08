import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFaa, parseFaaXml, minutesOf, severityOf, updateTime, briefing as faa } from '../apis/sources/faa-airports.mjs';
import { parseRegulators, parseRegulatorFeed, dateOf, briefing as regulators } from '../apis/sources/regulators.mjs';

const NOW = Date.parse('2026-10-08T17:30:00Z');
const faaXml = (body, time = 'Thu Oct 8 17:24:27 2026 GMT') => `<AIRPORT_STATUS_INFORMATION><Update_Time>${time}</Update_Time>${body}</AIRPORT_STATUS_INFORMATION>`;
const GDP = '<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>BOS</ARPT><Reason>runway construction</Reason><Avg>1 hour and 23 minutes</Avg><Max>3 hours and 6 minutes</Max></Ground_Delay><Ground_Delay><ARPT>ZZZ</ARPT><Reason>other</Reason><Avg>21 minutes</Avg><Max>1 hour</Max></Ground_Delay></Ground_Delay_List></Delay_type>';
const STOP = '<Delay_type><Name>Ground Stops</Name><Ground_Stop_List><Ground_Stop><ARPT>BOS</ARPT><Reason>thunderstorms</Reason><End_Time>6:00 pm EDT</End_Time></Ground_Stop></Ground_Stop_List></Delay_type>';
const CLOSURE = '<Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>LAX</ARPT><Reason>!LAX 05/277 AP CLSD TO NON SKED TRANSIENT GA ACFT</Reason></Airport></Airport_Closure_List></Delay_type>';

test('FAA: durations in words become minutes, programmes become rows at the airport position, a ground stop beats a delay, closures are ignored', () => {
  assert.deepEqual(['1 hour and 23 minutes', '45 minutes', '2 hours', 'soon'].map(minutesOf), [83, 45, 120, null]);
  assert.equal(updateTime('Thu Oct 8 17:24:27 2026 GMT'), '2026-10-08T17:24:27.000Z');
  assert.equal(updateTime('yesterday'), null);
  assert.deepEqual([severityOf('ground stop', 5), severityOf('ground delay', 20), severityOf('ground delay', 45), severityOf('ground delay', 83), severityOf('ground delay', 95)], ['high', 'low', 'moderate', 'elevated', 'high']);
  const result = parseFaa(faaXml(GDP + CLOSURE), NOW);
  assert.equal(result.status, 'ok');
  assert.equal(result.observations.length, 2);
  const bos = result.observations.find(row => row.providerId === 'faa:BOS');
  assert.deepEqual([bos.severity, bos.avgDelayMin, bos.locationMethod, bos.lat], ['elevated', 83, 'airport', 42.3656]);
  const unknown = result.observations.find(row => row.providerId === 'faa:ZZZ');
  assert.equal(unknown.lat, undefined, 'an airport outside the table keeps its row without a position');
  assert.ok(!result.observations.some(row => row.providerId === 'faa:LAX'), 'NOTAM restrictions are not closures');
  const both = parseFaaXml(faaXml(GDP + STOP));
  assert.equal(both.programmes.find(p => p.airport === 'BOS').kind, 'ground stop');
});

test('FAA: a quiet network is a valid empty answer; a foreign document, a future time or a failed request is an error; cached 5 minutes', async () => {
  const quiet = parseFaa(faaXml(''), NOW);
  assert.deepEqual([quiet.status, quiet.observations.length], ['ok', 0]);
  assert.equal(parseFaa('<html>nope</html>', NOW).status, 'error');
  assert.equal(parseFaa(faaXml('', 'Thu Oct 8 23:59:00 2026 GMT'), NOW).status, 'error');
  assert.equal(parseFaa(faaXml('', 'Wed Oct 7 08:00:00 2026 GMT'), NOW).status, 'stale');
  assert.equal((await faa({ now: NOW, fetcher: async () => ({ error: 'HTTP 500' }) })).status, 'error');
  let calls = 0;
  const fetcher = async () => { calls++; return { rawText: faaXml(GDP) }; };
  assert.equal((await faa({ now: NOW, fetcher, useCache: true })).observations.length, 2);
  const before = calls;
  await faa({ now: NOW + 60000, fetcher, useCache: true });
  assert.equal(calls, before);
});

const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items.map(i => `<item><title>${i.title}</title><link><![CDATA[${i.link}]]></link><pubDate>${i.date}</pubDate></item>`).join('')}</channel></rss>`;
const FED = { agency: 'Fed', host: 'www.federalreserve.gov' };

test('Regulators: dates in both formats, links only on the agency host, CDATA and markup handled', () => {
  assert.equal(dateOf('Wed, 7 Oct 2026 18:00:00 GMT'), '2026-10-07T18:00:00.000Z');
  assert.equal(dateOf('Oct 05, 2026'), '2026-10-05T00:00:00.000Z');
  assert.equal(dateOf('later'), null);
  const items = parseRegulatorFeed(rss([
    { title: 'Minutes of the &lt;b&gt;FOMC&lt;/b&gt;', link: 'https://www.federalreserve.gov/a.htm', date: 'Wed, 7 Oct 2026 18:00:00 GMT' },
    { title: 'Evil', link: 'https://evil.example/x', date: 'Wed, 7 Oct 2026 18:00:00 GMT' },
    { title: 'Future', link: 'https://www.federalreserve.gov/b.htm', date: 'Wed, 7 Oct 2027 18:00:00 GMT' }]), FED, NOW);
  assert.deepEqual(items.map(i => i.title), ['Minutes of the FOMC']);
  assert.equal(parseRegulatorFeed('<html></html>', FED, NOW), null);
});

test('Regulators: newest first across feeds, FOMC headlines moderate, old items dropped, a failed feed named, all failed is an error, cached 30 minutes', async () => {
  const fed = rss([{ title: 'Minutes of the Federal Open Market Committee', link: 'https://www.federalreserve.gov/a.htm', date: 'Wed, 7 Oct 2026 18:00:00 GMT' }, { title: 'Old', link: 'https://www.federalreserve.gov/o.htm', date: 'Mon, 1 Jun 2026 18:00:00 GMT' }]);
  const sec = rss([{ title: 'SEC charges', link: 'https://www.sec.gov/s.htm', date: 'Tue, 06 Oct 2026 16:30:24 -0400' }]);
  const result = parseRegulators({ Fed: fed, SEC: sec, FINRA: null }, NOW);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.observations.map(row => [row.agency, row.severity]), [['Fed', 'moderate'], ['SEC', 'info']]);
  assert.match(result.summary, /Warning: the FINRA feed failed/);
  assert.equal(parseRegulators({ Fed: null, SEC: null, FINRA: null }, NOW).status, 'error');
  let calls = 0;
  const fetcher = async () => { calls++; return { rawText: sec.replace('www.sec.gov', 'www.finra.org') }; };
  await regulators({ now: NOW, fetcher, useCache: true });
  const before = calls;
  await regulators({ now: NOW + 60000, fetcher, useCache: true });
  assert.equal(calls, before);
});
