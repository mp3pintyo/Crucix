// Chokepoint exposure of a country: which narrow sea passages a country's trade is considered to lean on, and what the traffic there looks like now.
// The dependency table is World Monitor's editorial list (koala73/worldmonitor, AGPL-3.0, shared/analysis-infrastructure-cascade.ts,
// getChokepointDependentCountries): a judgement of how much a country relies on a passage (`strength`, 0-1) and how well it could route around it
// (`redundancy`, 0-1). It is NOT measured trade data and the numbers are not statistics: the country sheet says so. The index is World Monitor's
// impact formula for a full closure, strength x (1 - redundancy). The live part is the IMF PortWatch row of the same passage (7-day mean of ship
// transits against the 28-day median), when the live source is current.
import { countryByIso2 } from './countries.mjs';

// Passage ids are the PortWatch slugs of apis/sources/portwatch.mjs; `basis` says what the country is considered to depend on the passage for.
const TABLE = Object.freeze({
  hormuz: { name: 'Strait of Hormuz', rows: [['JP', 0.8, 0.2, 'oil'], ['KR', 0.7, 0.2, 'oil'], ['IN', 0.6, 0.3, 'oil'], ['CN', 0.5, 0.4, 'oil']] },
  suez: { name: 'Suez Canal', rows: [['DE', 0.6, 0.3, 'trade'], ['IT', 0.5, 0.3, 'trade'], ['GB', 0.5, 0.4, 'trade'], ['CN', 0.4, 0.5, 'trade']] },
  malacca: { name: 'Malacca Strait', rows: [['CN', 0.7, 0.3, 'oil'], ['JP', 0.6, 0.3, 'trade'], ['KR', 0.6, 0.3, 'trade']] },
  bab_el_mandeb: { name: 'Bab el-Mandeb Strait', rows: [['DE', 0.5, 0.4, 'trade'], ['GB', 0.5, 0.4, 'trade'], ['SA', 0.4, 0.5, 'access']] },
  panama: { name: 'Panama Canal', rows: [['US', 0.5, 0.4, 'trade'], ['CN', 0.4, 0.5, 'trade']] },
  gibraltar: { name: 'Gibraltar Strait', rows: [['ES', 0.4, 0.5, 'access'], ['IT', 0.3, 0.5, 'trade']] },
  bosporus: { name: 'Bosporus Strait', rows: [['RU', 0.6, 0.3, 'access'], ['UA', 0.6, 0.3, 'access'], ['RO', 0.4, 0.4, 'access']] },
});
export const EXPOSURE_BASES = Object.freeze(['oil', 'trade', 'access']);

const BY_COUNTRY = new Map();
for (const [slug, { name, rows }] of Object.entries(TABLE)) {
  for (const [iso2, strength, redundancy, basis] of rows) {
    const country = countryByIso2(iso2);
    if (!country) continue;
    const list = BY_COUNTRY.get(country.iso3) ?? [];
    list.push(Object.freeze({ chokepoint: slug, name, strength, redundancy, index: Math.round(strength * (1 - redundancy) * 100) / 100, basis }));
    BY_COUNTRY.set(country.iso3, list);
  }
}

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The current PortWatch state of each passage in the live sources: { slug -> { changePct, mean7d, baseline28d, observedAt, severity } }.
function liveStates(liveSources) {
  const states = new Map();
  const source = Array.isArray(liveSources) ? liveSources.find(item => item?.source === 'IMF-PortWatch') : null;
  if (!source || source.status !== 'ok' || !Array.isArray(source.observations)) return states;
  for (const row of source.observations.slice(0, 40)) {
    const slug = typeof row?.providerId === 'string' ? row.providerId.split(':')[0] : '';
    if (!Object.hasOwn(TABLE, slug)) continue;
    const fact = label => number((Array.isArray(row.facts) ? row.facts : []).find(item => item?.label === label)?.value);
    states.set(slug, { changePct: fact('changePct'), mean7d: fact('mean7d'), baseline28d: fact('baseline28d'), observedAt: typeof row.observedAt === 'string' ? row.observedAt.slice(0, 40) : null,
      severity: typeof row.severity === 'string' ? row.severity.slice(0, 20) : null });
  }
  return states;
}

/**
 * The exposure rows of a country (ISO3), highest index first: { chokepoint, name, strength, redundancy, index, basis, live }, `live` being the
 * current PortWatch state of the passage or null. An empty list for a country without an entry.
 */
export function exposureOf(iso3, liveSources = null) {
  const rows = typeof iso3 === 'string' ? BY_COUNTRY.get(iso3.toUpperCase()) : null;
  if (!rows) return [];
  const states = liveStates(liveSources);
  return [...rows].sort((a, b) => b.index - a.index || (a.chokepoint < b.chokepoint ? -1 : 1)).map(row => ({ ...row, live: states.get(row.chokepoint) ?? null }));
}

/** Countries that have an exposure entry (ISO3), for tests and documentation. */
export const exposedCountries = () => [...BY_COUNTRY.keys()].sort();
