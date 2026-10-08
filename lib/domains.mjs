// Dashboard domains (the "lenses"): every source adapter of apis/briefing.mjs belongs to exactly one of them.
// dashboard/public/domains.js is the browser copy of this data; test/domains.test.mjs keeps the two identical
// and checks the lists against the adapters the briefing runs and the live-source policies.
const domain = (id, sources) => Object.freeze({ id, sources: Object.freeze(sources) });

export const DOMAINS = Object.freeze([
  domain('security', ['GDELT', 'ACLED', 'ReliefWeb', 'ADSB-Military', 'ADS-B', 'OpenSky', 'Maritime', 'Telegram', 'Bluesky', 'Reddit', 'KiwiSDR', 'VIEWS-Forecast', 'INFORM-Risk', 'Travel-Advisories', 'GPSJam', 'UNHCR-Arrivals']),
  domain('hazards', ['USGS', 'EMSC', 'GDACS', 'Copernicus-EMS', 'NASA-EONET', 'FIRMS', 'Meteoalarm', 'MET-Norway', 'Aviation-SIGMET', 'NOAA', 'WMO-SWIC']),
  domain('space', ['NOAA-SWPC', 'Space']),
  domain('cyber', ['CISA-KEV', 'FIRST-EPSS', 'OONI', 'IODA', 'Cloudflare-Radar', 'RIPEstat', 'ThreatFox', 'HIBP', 'SEC-8K', 'MISP-Galaxy']),
  domain('economy', ['FRED', 'Treasury', 'BLS', 'ECB', 'YFinance', 'USAspending', 'Prediction-Markets', 'Patents']),
  domain('supply', ['EIA', 'Energy-Charts-HU', 'ENTSOG-HU', 'IMF-PortWatch', 'GSCPI', 'Comtrade']),
  domain('sanctions', ['OFAC', 'OpenSanctions', 'OpenSanctions-Index', 'Federal-Register']),
  domain('health', ['WHO', 'EPA', 'Safecast']),
]);

export const DOMAIN_IDS = Object.freeze(DOMAINS.map(item => item.id));

// A Map, so that a name like "constructor" or "__proto__" is simply unknown.
const BY_SOURCE = new Map(DOMAINS.flatMap(item => item.sources.map(source => [source, item.id])));

export function domainOfSource(name) {
  return typeof name === 'string' ? BY_SOURCE.get(name) ?? null : null;
}

// An event record carries its source as `source.name` (lib/intelligence/events.mjs); a flat export record as `sourceName`.
// News, OSINT and signal events come from sources outside the table and have no domain.
export function domainOfEvent(event) {
  if (event === null || typeof event !== 'object') return null;
  const nested = event.source !== null && typeof event.source === 'object' ? event.source.name : undefined;
  return domainOfSource(nested ?? event.sourceName);
}
