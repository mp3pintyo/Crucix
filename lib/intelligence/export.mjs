import { randomUUID } from 'node:crypto';
import { getLocaleForLanguage } from '../i18n.mjs';
import { HistoryValidationError, normalizeHistoryEvent, normalizeIsoTime, validateHistoryFilters } from './history.mjs';

const CAP = 2000;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
// The report's own sentences and headings in the export language (locales/*.json `export`, English for a missing key). Field names,
// the CSV header, the provenance lines (`key: value`), codes and the records' own text stay as they are in every language.
const wordsFor = language => ({ ...getLocaleForLanguage('en').export, ...getLocaleForLanguage(language).export });
const FORMAT = { json: ['application/json; charset=utf-8', 'json'], csv: ['text/csv; charset=utf-8', 'csv'], html: ['text/html; charset=utf-8', 'html'], stix: ['application/stix+json; version=2.1; charset=utf-8', 'stix.json'] };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fields = ['id', 'kind', 'title', 'summary', 'sourceName', 'sourceUrl', 'sourceHostname', 'sourceStatus', 'observedAt', 'publishedAt', 'forecastAt', 'startsAt', 'validUntil', 'collectedAt', 'firstSeenAt', 'lastSeenAt', 'lat', 'lon', 'locationMethod', 'locationLabel', 'locationPrecision', 'severity', 'qualityLevel', 'qualityChecks', 'explanationCodes', 'relatedSources', 'exportGeneratedAt', 'exportTotal', 'exportCount', 'exportTruncated', 'exportFilters'];

function csvCell(value) {
  let safe = String(value ?? '');
  // Excel and other spreadsheet readers may ignore leading whitespace/control.
  if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(safe)) safe = `'${safe}`;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csv(records, metadata) {
  const rows = records.length ? records : [null];
  return fields.map(csvCell).join(',') + '\r\n' + rows.map(record => {
    const flat = record ? {
      ...record, sourceName: record.source.name, sourceUrl: record.source.url, sourceHostname: record.source.hostname, sourceStatus: record.source.status,
      lat: record.location.lat, lon: record.location.lon, locationMethod: record.location.method, locationLabel: record.location.label, locationPrecision: record.location.precision,
      qualityLevel: record.quality.level, qualityChecks: JSON.stringify(record.quality.checks), explanationCodes: record.quality.explanationCodes.join('; '), relatedSources: JSON.stringify(record.relatedSources),
    } : {};
    Object.assign(flat, { exportGeneratedAt: metadata.generatedAt, exportTotal: metadata.total, exportCount: metadata.exported, exportTruncated: metadata.truncated, exportFilters: JSON.stringify(metadata.filters) });
    return fields.map(field => csvCell(flat[field])).join(',');
  }).join('\r\n') + '\r\n';
}

const provenanceText = record => [
  `kind: ${record.kind}`, `severity: ${record.severity}`, `observedAt: ${record.observedAt || 'unknown'}`, `publishedAt: ${record.publishedAt || 'unknown'}`,
  ...(record.forecastAt ? [`forecastAt: ${record.forecastAt}`] : []), ...(record.startsAt ? [`startsAt: ${record.startsAt}`] : []), ...(record.validUntil ? [`validUntil: ${record.validUntil}`] : []),
  `collectedAt: ${record.collectedAt || 'unknown'}`, `firstSeenAt: ${record.firstSeenAt || 'unknown'}`, `lastSeenAt: ${record.lastSeenAt || 'unknown'}`,
  `sourceStatus: ${record.source.status}`, `location: ${record.location.label || 'unknown'}`, `coordinates: ${record.location.lat === null ? 'unknown' : `${record.location.lat}, ${record.location.lon}`}`,
  `locationMethod: ${record.location.method}`, `locationPrecision: ${record.location.precision}`, `qualityLevel: ${record.quality.level}`,
  `qualityChecks: ${JSON.stringify(record.quality.checks)}`, `explanationCodes: ${record.quality.explanationCodes.join(', ') || 'none'}`,
].join('\n');

function summary(metadata, words) {
  return fill(words.summary, {
    exported: metadata.exported, total: metadata.total, scope: metadata.truncated ? fill(words.truncated, { cap: CAP }) : words.complete,
    generatedAt: metadata.generatedAt, filters: JSON.stringify(metadata.filters),
  });
}

function html(records, metadata, words) {
  const link = source => source.url ? `<a href="${escape(source.url)}" rel="noopener noreferrer">${escape(source.name)}</a>` : escape(source.name);
  const articles = records.map(record => `<article><h2>${escape(record.title)}</h2><p>${escape(record.summary)}</p><p>${link(record.source)} · ${escape(record.source.hostname || words.unknownHost)}</p><pre>${escape(provenanceText(record))}</pre>${record.relatedSources.length ? `<p>${fill(escape(words.related), { list: record.relatedSources.map(link).join(' · ') })}</p>` : ''}<small>${escape(record.id)}</small></article>`).join('\n');
  return `<!doctype html><html lang="${escape(metadata.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(words.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;color:#17212b;background:#fff;margin:2rem auto;padding:0 1rem;max-width:64rem}h1,h2{line-height:1.25}article{border-top:1px solid #bbb;margin:1.5rem 0;padding-top:1rem;break-inside:avoid}a{color:#174ca0;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#555}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}a{color:inherit}a:after{content:' (' attr(href) ')';font-size:9pt}article{break-inside:auto}h2{break-after:avoid}}</style></head><body><h1>${escape(words.title)}</h1><p>${escape(summary(metadata, words))}</p>${articles || `<p>${escape(words.empty)}</p>`}</body></html>`;
}

function stix(records, metadata, words) {
  // OASIS STIX 2.1 Â§Â§4.13, 4.16: notes and reports require object_refs.
  // Notes contextualize this export report; the report collects those notes.
  // A summary note also makes an empty-result report valid without cyber claims.
  const reportId = `report--${randomUUID()}`;
  const noteId = () => `note--${randomUUID()}`;
  const common = { spec_version: '2.1', created: metadata.generatedAt, modified: metadata.generatedAt, lang: metadata.language };
  const notes = [{ type: 'note', id: noteId(), ...common, abstract: words.scopeNote, content: summary(metadata, words), object_refs: [reportId] }];
  for (const record of records) {
    // `source_name: 'Crucix event'` names the reference type for STIX consumers: it stays English.
    const external_references = [{ source_name: 'Crucix event', external_id: record.id }];
    if (record.source.url) external_references.push({ source_name: record.source.name, url: record.source.url });
    for (const related of record.relatedSources) external_references.push({ source_name: related.name, url: related.url, description: words.relatedNote });
    notes.push({ type: 'note', id: noteId(), ...common, abstract: record.title, content: `${record.title}\n\n${record.summary}\n\n${provenanceText(record)}\n\n${words.contextOnly}`, object_refs: [reportId], external_references });
  }
  const report = { type: 'report', id: reportId, ...common, name: words.reportName, description: summary(metadata, words), published: metadata.generatedAt, object_refs: notes.map(note => note.id) };
  return JSON.stringify({ type: 'bundle', id: `bundle--${randomUUID()}`, objects: [report, ...notes] }, null, 2);
}

export function exportRecords(records, format, { generatedAt = new Date().toISOString(), total, language = 'en', filters = {} } = {}) {
  if (!Array.isArray(records)) throw new HistoryValidationError('Export records must be an array', 'records', 'INVALID_EXPORT');
  if (typeof format !== 'string' || !Object.hasOwn(FORMAT, format)) throw new HistoryValidationError('Unknown export format', 'format', 'INVALID_EXPORT');
  const timestamp = normalizeIsoTime(generatedAt);
  if (!timestamp) throw new HistoryValidationError('Invalid export generation timestamp', 'generatedAt', 'INVALID_EXPORT');
  if (!['hu', 'en', 'fr'].includes(language)) throw new HistoryValidationError('Unknown export language', 'language', 'INVALID_EXPORT');
  if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) throw new HistoryValidationError('Invalid export total', 'total', 'INVALID_EXPORT');
  const checked = validateHistoryFilters(filters);
  const normalized = records.slice(0, CAP).map(normalizeHistoryEvent).filter(Boolean);
  const matchingTotal = Math.max(total ?? records.length, normalized.length);
  const metadata = { generatedAt: timestamp, total: matchingTotal, exported: normalized.length, truncated: matchingTotal > normalized.length, language, filters: Object.fromEntries(['q', 'kind', 'source', 'from', 'to'].filter(key => checked[key]).map(key => [key, checked[key]])) };
  const words = wordsFor(language);
  const body = format === 'json' ? JSON.stringify({ ...metadata, records: normalized }, null, 2) : format === 'csv' ? csv(normalized, metadata) : format === 'html' ? html(normalized, metadata, words) : stix(normalized, metadata, words);
  const [contentType, extension] = FORMAT[format];
  return { contentType, extension, body };
}
