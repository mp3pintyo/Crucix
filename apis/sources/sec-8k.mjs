// SEC EDGAR: Form 8-K filings that report a material cybersecurity incident (Item 1.05). Since December 2023 a US listed company must disclose
// within four business days a cybersecurity incident it has determined to be material, under Item 1.05 of Form 8-K. The EDGAR full-text search
// (https://efts.sec.gov/LATEST/search-index, no key) finds the filings by their item heading. Checked live on 2026-10-08:
//   - GET .../search-index?q=<phrase>&forms=8-K&dateRange=custom&startdt=<day>&enddt=<day> -> { hits: { total, hits: [
//     { _id: "<accession>:<document>", _source: { form, items: ["1.05", ...], file_date, display_names, ciks, adsh, file_type, ... } } ] } }.
//     One hit per DOCUMENT of a filing, and every document repeats the filing's `items`; `forms=8-K` also returns 8-K/A amendments. The exact
//     Neither phrase finds every filing (90 days to 2026-10-08: "Material Cybersecurity Incidents" 7 filings, "Item 1.05" 8, together 8, and the broad
//     "cybersecurity incident", 119 hits and 3 filings in its first 100, added nothing), so the two phrases are searched one after the other and the
//     union is read; `items` decides which hits are Item 1.05 filings. A second request right after the first was once answered without hits, so
//     the requests are spaced a second apart; one failed phrase still gives a partial answer, said in the summary.
//   - Measured over 13 months to 2026-10-08: 26 filings with Item 1.05 (about two a month), the longest gap between two 57 days. The row window and the
//     feed limit are therefore both 90 days: a quiet quarter reads as expired, which is true to the data (the newest filing is that old).
//   - The search has no feed time: the newest `file_date` (a plain day in US time, read as UTC midnight) stands in for it.
// SEC's fair-access policy asks for a declared User-Agent and at most 10 requests a second. This adapter asks once an hour. It sends the plain
// Crucix agent, which SEC accepts (an agent with a URL and an e-mail address was answered with HTTP 403 in the same check); an operator who wants to
// declare contact details sets SEC_USER_AGENT (printable ASCII, at most 200 characters).
// A filing says that a company judged an incident material; what happened is in the filing itself, which the row links to. Every row is rated high.
// Every regex below runs on text that was cut to a fixed length first.
import { safeFetch } from '../utils/fetch.mjs';
import { providerTime, freshness, freshResult, unavailableResult, POLICIES } from '../utils/freshness.mjs';

const SOURCE = 'SEC-8K';
const ENDPOINT = 'https://efts.sec.gov/LATEST/search-index';
const ARCHIVE = 'https://www.sec.gov/Archives/edgar/data/';
const QUERIES = Object.freeze(['"Material Cybersecurity Incidents"', '"Item 1.05"']);
const PAUSE_MS = 1000;
const WINDOW_DAYS = 90;
const MAX_HITS = 100;
const MAX_ROWS = 20;
const FUTURE_SKEW_MS = 300000;
const CACHE_MS = 3600000;
const REQUEST = Object.freeze({ timeout: 15000, retries: 0, maxBytes: 4 * 1024 * 1024 });
const cache = { payload: null, fetcher: null, collectedAt: 0 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const CIK = /^\d{1,10}$/;
const DOCUMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const EXTRAS = {
  attribution: 'Source: U.S. Securities and Exchange Commission, EDGAR (https://www.sec.gov/edgar)',
  rights: 'SEC EDGAR filings are public documents of the U.S. government. Crucix lists the company, the form and the filing date and links to the filing; it does not read or summarise the filing text. EDGAR is asked once an hour.',
  license: 'Public domain (U.S. Government work)',
  licenseUrl: 'https://www.sec.gov/privacy#dissemination',
  summary: 'Form 8-K filings of the last 90 days that report a material cybersecurity incident (Item 1.05), newest first. The filing says that the company judged the incident material; what happened is in the filing, which each row links to. The day shown is the filing day in US time, read as 00:00 UTC.',
};

// Provider text becomes inert plain text: markup, control, bidi and zero-width characters go, whitespace collapses.
const clean = (value, cap) => typeof value === 'string'
  ? value.slice(0, 300).replace(/<[^<>]*>/g, '').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').replace(/[<>]/g, '').trim().slice(0, cap).trim() : '';
// Transport errors become a short reason; a URL or an upstream message never reaches the result.
function failure(error) {
  const reason = typeof error === 'string' ? error.slice(0, 300).replace(/https?:\/\/\S*/gi, '').trim().slice(0, 120) : '';
  return `SEC EDGAR request failed${reason ? `: ${reason}` : ''}`;
}

// "Astrana Health, Inc.  (ASTH)  (CIK 0001083446)" -> { company, ticker }; the CIK comes from the `ciks` field.
function nameOf(raw) {
  const text = typeof raw === 'string' ? raw.slice(0, 300) : '';
  const cut = text.indexOf('  (');
  const company = clean(cut > 0 ? text.slice(0, cut) : text.replace(/\(CIK[^)]*\)/, ''), 120);
  const ticker = [...text.matchAll(/\(([A-Za-z][A-Za-z0-9.,\- ]{0,30})\)/g)].map(match => match[1].split(',')[0].trim()).find(item => TICKER.test(item) && !item.startsWith('CIK')) || '';
  return { company, ticker };
}

function filing(hit) {
  const source = hit?._source;
  if (!source || typeof source !== 'object' || !Array.isArray(source.items) || !source.items.slice(0, 40).includes('1.05')) return null;
  const form = source.form === '8-K' || source.form === '8-K/A' ? source.form : null;
  const accession = typeof source.adsh === 'string' && source.adsh.length === 20 && ACCESSION.test(source.adsh) ? source.adsh : null;
  const day = typeof source.file_date === 'string' && source.file_date.length === 10 && DAY.test(source.file_date) ? providerTime(source.file_date) : null;
  const cik = Array.isArray(source.ciks) && typeof source.ciks[0] === 'string' && source.ciks[0].length <= 10 && CIK.test(source.ciks[0]) ? String(Number(source.ciks[0])) : null;
  const { company, ticker } = nameOf(Array.isArray(source.display_names) ? source.display_names[0] : '');
  if (!form || !accession || !day || !cik || !company) return null;
  const document = typeof hit._id === 'string' && hit._id.length <= 160 && hit._id.startsWith(accession + ':') ? hit._id.slice(accession.length + 1) : '';
  // The main document of the filing is the best link; an exhibit or an odd name falls back to the filing's index folder.
  const main = source.file_type === '8-K' || source.file_type === '8-K/A';
  return { accession, form, day, cik, company, ticker, document: main && DOCUMENT.test(document) ? document : '' };
}

// `answers`: the answer of each search phrase (a single answer is read as a list of one).
export function parseSec8k(answers, { now = Date.now() } = {}) {
  const given = (Array.isArray(answers) ? answers : [answers]).slice(0, QUERIES.length);
  const list = [];
  let failedQueries = 0, firstError;
  for (const answer of given) {
    if (!answer || typeof answer !== 'object' || answer.error || !Array.isArray(answer.hits?.hits)) { failedQueries++; if (answer?.error !== undefined) firstError ??= answer.error; continue; }
    list.push(...answer.hits.hits.slice(0, MAX_HITS));
  }
  if (!given.length || failedQueries === given.length) return unavailableResult(SOURCE, firstError === undefined ? 'SEC EDGAR returned an unexpected response' : failure(firstError), EXTRAS, now);
  const found = new Map();
  let bad = 0;
  for (const hit of list) {
    const item = filing(hit);
    if (!item) {
      // A hit of another item set (8.01, 9.01 ...) is not a failure; only a hit without the expected fields at all is.
      if (!hit?._source || typeof hit._source !== 'object' || !Array.isArray(hit._source.items)) bad++;
      continue;
    }
    if (Date.parse(item.day) - now > FUTURE_SKEW_MS) continue;
    const known = found.get(item.accession);
    if (!known || (!known.document && item.document)) found.set(item.accession, item);
  }
  if (list.length && bad === list.length) return unavailableResult(SOURCE, 'SEC EDGAR returned hits in an unexpected shape', EXTRAS, now);
  const all = [...found.values()];
  // The newest filing day, old or not: an old list is expired rather than undated.
  const newest = all.map(item => item.day).sort().at(-1) ?? null;
  const ranked = all.filter(item => freshness(item.day, POLICIES[SOURCE].observationMaxAgeMs, now).fresh)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || (a.accession < b.accession ? 1 : -1));
  const rows = ranked.slice(0, MAX_ROWS).map(item => {
    const folder = `${ARCHIVE}${item.cik}/${item.accession.replaceAll('-', '')}/`;
    const amended = item.form === '8-K/A';
    return { kind: 'cyber', providerId: item.accession, source: SOURCE,
      title: `${item.company}${item.ticker ? ` (${item.ticker})` : ''}: ${amended ? 'amended ' : ''}material cybersecurity incident disclosed (8-K Item 1.05)`,
      summary: `${item.company} filed ${amended ? 'an amendment (Form 8-K/A)' : 'a Form 8-K'} on ${item.day.slice(0, 10)} that reports a cybersecurity incident under Item 1.05, which a company uses once it has determined the incident to be material. The filing describes what happened; Crucix does not read it.`,
      url: item.document ? folder + item.document : folder, observedAt: item.day, publishedAt: item.day, severity: 'high',
      company: item.company, ...(item.ticker ? { ticker: item.ticker } : {}), formType: item.form, cik: item.cik };
  });
  const note = (failedQueries ? ` Warning: ${failedQueries} of the ${given.length} search requests failed, so the list may be incomplete.` : '')
    + (bad ? ` Warning: ${bad} of the ${list.length} search hits could not be read and were skipped.` : '');
  return freshResult(SOURCE, newest, rows, { ...EXTRAS, summary: EXTRAS.summary + note, examinedRecords: list.length, truncatedRecords: Math.max(0, ranked.length - MAX_ROWS) }, now);
}

function userAgent() {
  const own = process.env.SEC_USER_AGENT;
  return typeof own === 'string' && own.length <= 200 && /^[\x20-\x7e]+$/.test(own) ? own : null;
}

export async function briefing(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const fetcher = options.fetcher || safeFetch;
  const useCache = options.useCache ?? !options.fetcher;
  if (useCache && cache.payload && cache.fetcher === fetcher && now >= cache.collectedAt && now - cache.collectedAt < CACHE_MS) return parseSec8k(cache.payload, { now });
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const agent = userAgent();
  const request = { ...REQUEST, timeout: Math.max(1, Math.min(REQUEST.timeout, Number(options.timeout) || REQUEST.timeout)), ...(agent ? { headers: { 'User-Agent': agent } } : {}) };
  const pause = Number.isFinite(options.pause) ? options.pause : PAUSE_MS;
  const answers = [];
  for (const [index, phrase] of QUERIES.entries()) {
    if (index && pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
    const query = new URLSearchParams({ q: phrase, forms: '8-K', dateRange: 'custom', startdt: day(now - WINDOW_DAYS * 86400000), enddt: day(now) });
    try { answers.push(await fetcher(`${ENDPOINT}?${query}`, request)); } catch { answers.push({ error: 'network error' }); }
  }
  const result = parseSec8k(answers, { now });
  // Only a result with at least one readable answer is kept; a failed one is asked again at the next sweep.
  if (useCache && result.status !== 'error') { cache.payload = answers; cache.fetcher = fetcher; cache.collectedAt = now; }
  return result;
}

// Run standalone
if (process.argv[1]?.endsWith('sec-8k.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}
