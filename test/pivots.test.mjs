import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../dashboard/public/' + file, import.meta.url), 'utf8');
const load = (files = ['pivots.js']) => { const window = {}, context = vm.createContext({ window, Date, URL }); for (const file of files) vm.runInContext(read(file), context); return window; };
const at = Date.parse('2026-10-08T00:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
const fact = (label, value) => ({ label, value });

test('entities: CVE, public IPv4 and crypto addresses are found; private and look-alike text is not', () => {
  const { CrucixPivots: P } = load();
  const found = P.entitiesOf({ title: 'cve-2026-1234 exploited', summary: 'C2 at 8.8.4.4, not 10.0.0.1, 192.168.1.5, 127.0.0.1, 100.64.1.1 or 1.2.3.4.5. v999.1.1.1',
    facts: [fact('wallet', '0x' + 'a'.repeat(40)), fact('addr', 'bc1' + 'q'.repeat(30)), fact('word', 'abcdefghijklmnopqrstuvwxyzabcdef')] });
  assert.deepEqual(plain(found).map(e => e.type + ':' + e.value), ['cve:CVE-2026-1234', 'ip:8.8.4.4', 'eth:0x' + 'a'.repeat(40), 'btc:bc1' + 'q'.repeat(30)]);
  assert.deepEqual(plain(P.entitiesOf(null)), []);
});

test('a domain or a LEI counts only when a fact is labelled so', () => {
  const { CrucixPivots: P } = load();
  assert.deepEqual(plain(P.entitiesOf({ title: 'evil.example.com is mentioned here' })), []);
  const found = P.entitiesOf({ title: 'x', facts: [fact('domain', 'Evil.Example.com'), fact('lei', '5493001kjtiigc8y1r12'), fact('domain', 'not a domain')] });
  assert.deepEqual(plain(found).map(e => e.type + ':' + e.value), ['domain:evil.example.com', 'lei:5493001KJTIIGC8Y1R12']);
});

test('links are https, percent-encoded and at most six entities per record', () => {
  const { CrucixPivots: P } = load();
  const rec = { title: Array.from({ length: 12 }, (_, i) => `CVE-2026-${1000 + i}`).join(' '), facts: [fact('domain', 'a.example.org')] };
  const out = P.pivotsFor(rec);
  assert.equal(out.length, 6);
  for (const entity of out) for (const link of entity.links) assert.ok(link.url.startsWith('https://') && !link.url.includes('{v}'), link.url);
  assert.equal(P.pivotsFor({ title: 'CVE-2026-9999' })[0].links[0].url, 'https://nvd.nist.gov/vuln/detail/CVE-2026-9999');
  assert.equal(P.pivotsFor({ title: 'x', facts: [fact('domain', 'a.example.org')] })[0].links.at(-1).url, 'https://crt.sh/?q=a.example.org');
});

test('the inspector shows the pivot section, escaped, and works without pivots.js', () => {
  const rec = { key: 'k', title: 'CVE-2026-4242 <img onerror=x>', source: 'CISA-KEV', level: 'high', facts: [] };
  const view = window => ({ source: null, records: [], total: 0, filters: {}, limit: 25, selected: { record: rec, outdated: false } });
  const withPivots = load(['record-core.js', 'pivots.js', 'record-inspector.js']);
  const html = withPivots.CrucixRecordInspector.renderInspector(view(withPivots), (_, f) => f, at);
  assert.ok(html.includes('Look up elsewhere') && html.includes('href="https://nvd.nist.gov/vuln/detail/CVE-2026-4242"'));
  assert.ok(!html.includes('<img') && html.includes('rel="noopener noreferrer"'));
  const without = load(['record-core.js', 'record-inspector.js']);
  assert.ok(!without.CrucixRecordInspector.renderInspector(view(without), (_, f) => f, at).includes('Look up elsewhere'));
});

test('the page and the service worker load pivots.js before the inspector', () => {
  const html = read('jarvis.html');
  assert.ok(html.indexOf('<script src="pivots.js">') > 0 && html.indexOf('<script src="pivots.js">') < html.indexOf('<script src="record-inspector.js">'));
  assert.ok(read('sw.js').includes("'/pivots.js'"));
});

test('a company name and an SEC CIK pivot to company registers, only when a fact is labelled so', () => {
  const { CrucixPivots: P } = load();
  assert.deepEqual(plain(P.entitiesOf({ title: 'Boston Scientific discloses an incident', summary: 'CIK 885725' })), []);
  const out = plain(P.pivotsFor({ title: 'x', facts: [fact('company', 'Boston Scientific & Co'), fact('cik', '885725'), fact('cik', 'abc')] }));
  assert.deepEqual(out.map(entity => entity.type), ['company', 'cik']);
  assert.equal(out[0].links[1].url, 'https://opencorporates.com/companies?q=Boston%20Scientific%20%26%20Co');
  assert.equal(out[1].links[0].url, 'https://www.sec.gov/edgar/browse/?CIK=885725');
});
