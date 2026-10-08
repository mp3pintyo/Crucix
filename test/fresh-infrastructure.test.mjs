import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutingStatus, briefing as ripeBriefing } from '../apis/sources/ripestat.mjs';
import { parseEpss, briefing as epssBriefing } from '../apis/sources/epss.mjs';
import { parseOoniMeasurements, briefing as ooniBriefing } from '../apis/sources/ooni.mjs';

const now = Date.parse('2026-10-01T21:00:00Z');
function ripe(time = '2026-10-01T16:00:00', resource = '5483') {
  return { status: 'ok', data_call_status: 'supported', data: {
    resource, query_time: time, first_seen: { time: '2000-08-18T08:00:00' },
    last_seen: { time: '2026-10-01T16:00:00' },
    visibility: { v4: { ris_peers_seeing: 326, total_ris_peers: 326 }, v6: { ris_peers_seeing: 309, total_ris_peers: 316 } },
    announced_space: { v4: { prefixes: 113 }, v6: { prefixes: 10 } }, observed_neighbours: 108,
  } };
}
function epss(date = '2026-10-01', values = {}) {
  return { status: 'OK', 'status-code': 200, data: [{ cve: 'CVE-2021-44228', epss: '0.999990000', percentile: '1.000000000', date, ...values }] };
}
function measurement(values = {}) {
  return { measurement_uid: '20261001205033.276667_HU_webconnectivity_5e9fe60632c44fc3',
    measurement_start_time: '2026-10-01T20:50:32.123456Z', test_name: 'web_connectivity',
    probe_cc: 'HU', probe_asn: 'AS20845', input: 'https://example.org/',
    anomaly: false, confirmed: false, failure: false, ...values };
}
function ooni(values = {}) { return { results: [measurement(values)] }; }

test('RIPEstat uses the UTC query snapshot and reports observer fractions without invented locations', () => {
  const result = parseRoutingStatus(ripe(), { now });
  assert.equal(result.status, 'ok');
  assert.equal(result.observedAt, '2026-10-01T16:00:00.000Z');
  assert.equal(result.timestamp, '2026-10-01T21:00:00.000Z');
  assert.equal(result.observations.length, 1);
  const row = result.observations[0];
  assert.equal(row.providerId, 'AS5483:2026-10-01T16:00:00.000Z');
  assert.equal(row.visibility.v4.fraction, 1);
  assert.equal(row.visibility.v6.fraction, 309 / 316);
  assert.equal(row.announcedPrefixes.v4, 113);
  assert.equal(row.observedNeighbours, 108);
  assert.match(row.summary, /snapshot|batch/i);
  assert.equal(row.kind, 'network');
  for (const key of ['lat', 'lon', 'latitude', 'longitude', 'raw', 'first_seen']) assert.equal(key in row, false);
});

test('RIPEstat cannot substitute collection, first-seen, or last-seen time for a missing query date', () => {
  for (const value of [undefined, '2026-09-30T16:00:00', '2026-10-02T00:00:00', 'bad']) {
    const result = parseRoutingStatus(ripe(value === undefined ? null : value), { now });
    assert.equal(result.status, 'stale'); assert.equal(result.observations.length, 0);
  }
  assert.equal(parseRoutingStatus({ status: 'ok', data_call_status: 'supported', data: {} }, { now }).observedAt, null);
});

test('RIPEstat tolerates publication lag after the 8 h snapshot cadence but still expires a stuck provider', async () => {
  // Observed live: at 09:13 UTC the newest published snapshot was still 00:00 UTC.
  const lagging = Date.parse('2026-10-02T09:30:00Z');
  for (const check of [parseRoutingStatus(ripe('2026-10-02T00:00:00'), { now: lagging }),
    await ripeBriefing({ now: lagging, fetcher: async () => ripe('2026-10-02T00:00:00') })]) {
    assert.equal(check.status, 'ok'); assert.equal(check.stale, false); assert.equal(check.observations.length, 1);
  }
  const ceiling = Date.parse('2026-10-02T00:00:00Z') + 12 * 3600000;
  assert.equal(parseRoutingStatus(ripe('2026-10-02T00:00:00'), { now: ceiling }).status, 'ok');
  for (const late of [ceiling + 1000, Date.parse('2026-10-02T16:00:00Z')]) {
    const stuck = parseRoutingStatus(ripe('2026-10-02T00:00:00'), { now: late });
    assert.equal(stuck.status, 'stale'); assert.equal(stuck.freshness.reason, 'expired-provider-time'); assert.deepEqual(stuck.observations, []);
    assert.equal((await ripeBriefing({ now: late, fetcher: async () => ripe('2026-10-02T00:00:00') })).status, 'stale');
  }
});

test('RIPEstat rejects provider errors, changed endpoint support, and impossible visibility fractions', () => {
  assert.equal(parseRoutingStatus({ error: 'HTTP 503' }, { now }).status, 'error');
  assert.equal(parseRoutingStatus({ ...ripe(), data_call_status: 'deprecated' }, { now }).status, 'error');
  const payload = ripe(); payload.data.visibility.v4.ris_peers_seeing = 500;
  assert.equal(parseRoutingStatus(payload, { now }).observations[0].visibility.v4.fraction, null);
});

test('EPSS freshness follows the score date rather than the CVE year and remains a prediction', () => {
  const result = parseEpss(epss(), { now });
  assert.equal(result.status, 'ok'); assert.equal(result.observedAt, '2026-10-01T00:00:00.000Z');
  const row = result.observations[0];
  assert.equal(row.providerId, 'CVE-2021-44228:2026-10-01');
  assert.equal(row.epss, 0.99999); assert.equal(row.percentile, 1);
  assert.equal(row.kind, 'cyber'); assert.equal(row.severity, 'info');
  assert.equal(row.predictionWindowDays, 30);
  assert.match(row.summary, /prediction|predicted/i);
  assert.match(result.summary, /known exploitation|known.exploited/i);
  assert.equal(row.exploitationConfirmed, false);
  assert.match(result.attribution, /FIRST|Empirical Security/);
});

test('EPSS empty, unknown, stale and future score dates fail closed', () => {
  assert.equal(parseEpss({ status: 'OK', data: [], date: '2026-10-01' }, { now }).observedAt, null);
  for (const date of [null, 'bad', '2026-09-28', '2026-10-02']) {
    const result = parseEpss(epss(date), { now });
    assert.equal(result.status, 'stale'); assert.deepEqual(result.observations, []);
  }
  assert.equal(parseEpss({ error: 'HTTP 503' }, { now }).status, 'error');
  assert.equal(parseEpss({ status: 'ERROR', data: [] }, { now }).status, 'error');
});

test('EPSS excludes malformed identifiers and probabilities and cannot revive invalid rows with a fresh sibling', () => {
  for (const values of [{ epss: '' }, { epss: 'NaN' }, { epss: 1.2 }, { percentile: -1 }, { cve: 'CVE-2026-1' }, { cve: '<script>' }]) {
    assert.deepEqual(parseEpss(epss('2026-10-01', values), { now }).observations, []);
  }
  const payload = epss(); payload.data.push({ ...payload.data[0], cve: 'CVE-2026-12345', date: null });
  const result = parseEpss(payload, { now });
  assert.equal(result.observations.length, 1); assert.equal(result.rejectedObservations, 1);
  const low = parseEpss(epss('2026-10-01', { epss: '0.00001' }), { now });
  assert.match(low.summary, /does not supersede|does not override/i);
});

test('OONI distinguishes a failed measurement, an anomaly, confirmed blocking, and a healthy test', () => {
  const samples = [
    [{ failure: true }, 'measurement-failure', 'info', /error|failed/i],
    [{ anomaly: true }, 'anomaly', 'medium', /unconfirmed|not confirmed/i],
    [{ anomaly: true, confirmed: true }, 'confirmed-blocking', 'high', /confirmed/i],
    [{}, 'no-anomaly', 'info', /no anomaly|no blocking/i],
  ];
  for (const [flags, state, severity, text] of samples) {
    const result = parseOoniMeasurements(ooni(flags), { now });
    const row = result.observations[0];
    assert.equal(result.status, 'ok'); assert.equal(row.measurementStatus, state);
    assert.equal(row.severity, severity); assert.match(row.summary, text);
    assert.equal(row.blockingConfirmed, state === 'confirmed-blocking');
    assert.equal(row.observedAt, '2026-10-01T20:50:32.123Z');
    assert.equal(row.countryCode, 'HU'); assert.equal('lat' in row, false);
  }
  const failed = parseOoniMeasurements(ooni({ failure: true, anomaly: true, confirmed: true }), { now }).observations[0];
  assert.equal(failed.measurementStatus, 'measurement-failure'); assert.equal(failed.blockingConfirmed, false);
});

test('OONI links to the measurement and publishes only the input hostname, without credentials or parameters', () => {
  const row = parseOoniMeasurements(ooni({ input: 'https://alice:private@example.org/private/path?token=sensitive#secret', measurement_url: 'https://api.ooni.io/private?auth=secret' }), { now }).observations[0];
  assert.equal(row.targetHost, 'example.org');
  assert.equal(row.url, `https://explorer.ooni.org/m/${encodeURIComponent(row.providerId)}`);
  assert.doesNotMatch(JSON.stringify(row), /alice|private|sensitive|secret|auth=/);
  for (const measurement_uid of ['../../?token=secret', '.', '..']) assert.deepEqual(parseOoniMeasurements(ooni({ measurement_uid }), { now }).observations, []);
});

test('OONI empty, unknown, stale and future timestamps fail closed and malformed flags do not become findings', () => {
  assert.equal(parseOoniMeasurements({ results: [] }, { now }).observedAt, null);
  for (const measurement_start_time of [null, 'bad', '2026-09-30T20:00:00Z', '2026-10-01T21:06:00Z']) {
    const result = parseOoniMeasurements(ooni({ measurement_start_time }), { now });
    assert.equal(result.status, 'stale'); assert.equal(result.observations.length, 0);
  }
  assert.deepEqual(parseOoniMeasurements(ooni({ confirmed: 'true' }), { now }).observations, []);
  assert.equal(parseOoniMeasurements({ error: 'HTTP 503' }, { now }).status, 'error');
});

test('fresh siblings cannot revive stale, unknown or future EPSS and OONI observations', () => {
  const ep = epss();
  ep.data.push(...[null, '2026-09-28', '2026-10-02'].map((date, i) => ({ ...ep.data[0], cve: `CVE-2026-${10000 + i}`, date })));
  const oo = { results: [measurement(), ...[null, '2026-09-30T20:00:00Z', '2026-10-01T21:06:00Z'].map((measurement_start_time, i) => measurement({ measurement_uid: `mixed_${i}`, measurement_start_time }))] };
  for (const result of [parseEpss(ep, { now }), parseOoniMeasurements(oo, { now })]) {
    assert.equal(result.status, 'ok'); assert.equal(result.observations.length, 1); assert.equal(result.rejectedObservations, 3);
  }
});

test('infrastructure parsers bound output observations and never return provider raw bodies', () => {
  const ep = epss(); ep.data = Array.from({ length: 250 }, (_, i) => ({ ...ep.data[0], cve: `CVE-2026-${10000 + i}` }));
  const oo = { results: Array.from({ length: 250 }, (_, i) => measurement({ measurement_uid: `sample_${i}` })) };
  for (const result of [parseEpss(ep, { now }), parseOoniMeasurements(oo, { now }), parseRoutingStatus(ripe(), { now })]) {
    assert.ok(result.observations.length <= 100);
    assert.equal('raw' in result, false);
    for (const row of result.observations) {
      for (const key of ['title', 'summary', 'source', 'url', 'providerId', 'observedAt', 'publishedAt', 'kind', 'severity']) assert.ok(key in row, key);
      assert.equal('raw' in row, false);
    }
  }
});

test('briefings report transport failures without synthesizing successful freshness', async () => {
  for (const briefing of [ripeBriefing, epssBriefing, ooniBriefing]) {
    const result = await briefing({ now, fetcher: async () => ({ error: 'HTTP 503' }) });
    assert.equal(result.status, 'error'); assert.equal(result.observedAt, null); assert.deepEqual(result.observations, []);
    const thrown = await briefing({ now, fetcher: async () => { throw new Error('Transport failed'); } });
    assert.equal(thrown.status, 'error'); assert.deepEqual(thrown.observations, []);
  }
});

test('default briefings issue one bounded public request each with current low-load query parameters', async () => {
  const configurations = [
    [ripeBriefing, ripe(), url => { assert.equal(url.hostname, 'stat.ripe.net'); assert.equal(url.searchParams.get('resource'), 'AS5483'); assert.equal(url.searchParams.get('sourceapp'), 'Crucix'); }],
    [epssBriefing, epss(), url => { assert.equal(url.hostname, 'api.first.org'); assert.equal(url.searchParams.get('days'), '7'); assert.equal(url.searchParams.get('order'), '!epss'); assert.equal(url.searchParams.get('limit'), '20'); assert.equal(url.searchParams.has('cve'), false); }],
    [ooniBriefing, ooni(), url => { assert.equal(url.hostname, 'api.ooni.io'); assert.equal(url.searchParams.get('probe_cc'), 'HU'); assert.equal(url.searchParams.get('test_name'), 'web_connectivity'); assert.equal(Date.parse(url.searchParams.get('since')), now - 86400000); assert.equal(Date.parse(url.searchParams.get('until')), now); assert.equal(url.searchParams.get('limit'), '5'); assert.equal(url.searchParams.get('order'), 'desc'); }],
  ];
  for (const [briefing, payload, check] of configurations) {
    let requests = 0;
    const result = await briefing({ now, fetcher: async (value, options) => {
      requests++; check(new URL(value));
      assert.ok(options.timeout <= 10000); assert.ok(options.maxBytes <= 2 * 1024 * 1024); assert.ok(options.retries <= 1);
      return payload;
    } });
    assert.equal(requests, 1); assert.equal(result.status, 'ok');
  }
});

test('bounded options reject invalid resources and country codes before making network requests', async () => {
  let requests = 0; const fetcher = async () => { requests++; return {}; };
  for (const options of [{ resources: ['AS0', 'AS4294967296', 'AS1&evil=1'] }, { resources: [] }]) assert.equal((await ripeBriefing({ now, fetcher, ...options })).status, 'error');
  for (const cves of [[], ['CVE-2026-1', 'bad&query=1']]) assert.equal((await epssBriefing({ now, fetcher, cves })).status, 'error');
  for (const countries of [[], ['ZZ', 'HU&limit=1000', 'HUN']]) assert.equal((await ooniBriefing({ now, fetcher, countries })).status, 'error');
  assert.equal(requests, 0);
});

test('resource, country and CVE lists are capped and encoded without all-catalog pagination', async () => {
  let requests = 0;
  await ripeBriefing({ now, resources: ['AS1', 'AS2', 'AS3', 'AS4'], fetcher: async url => { requests++; return ripe('2026-10-01T16:00:00', new URL(url).searchParams.get('resource').slice(2)); } });
  assert.equal(requests, 3);
  requests = 0;
  await ooniBriefing({ now, countries: ['HU', 'AT', 'SK', 'CZ'], fetcher: async () => { requests++; return ooni(); } });
  assert.equal(requests, 3);
  requests = 0;
  await epssBriefing({ now, cves: Array.from({ length: 60 }, (_, i) => `CVE-2026-${10000 + i}`), fetcher: async value => {
    requests++; const url = new URL(value); assert.equal(url.searchParams.get('cve').split(',').length, 50); assert.equal(url.searchParams.has('days'), false); return epss();
  } });
  assert.equal(requests, 1);
});

test('cached payloads are revalidated and expired observations are never served as fresh fallback', async () => {
  const cases = [
    [ripeBriefing, { resources: ['AS13335'] }, ripe('2026-10-01T09:10:00', '13335')],
    [ooniBriefing, { countries: ['IS'] }, ooni({ probe_cc: 'IS', measurement_start_time: '2026-09-30T21:10:00Z' })],
  ];
  for (const [briefing, options, payload] of cases) {
    let requests = 0; const fetcher = async () => { requests++; return requests === 1 ? payload : { error: 'HTTP 503' }; };
    assert.equal((await briefing({ now, fetcher, useCache: true, ...options })).status, 'ok');
    const expired = await briefing({ now: now + 20 * 60000, fetcher, useCache: true, ...options });
    assert.equal(requests, 1); assert.equal(expired.status, 'stale'); assert.equal(expired.observations.length, 0);
    const failure = await briefing({ now: now + 61 * 60000, fetcher, useCache: true, ...options });
    assert.equal(requests, 2); assert.equal(failure.status, 'error'); assert.deepEqual(failure.observations, []);
  }
});
