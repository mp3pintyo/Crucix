const HOUR = 3600000;
export const POLICIES = Object.freeze({
  Meteoalarm: { maxAgeMs: 3*HOUR, observationMaxAgeMs: 48*HOUR },
  GDACS: { maxAgeMs: 6*HOUR, observationMaxAgeMs: 72*HOUR },
  'NOAA-SWPC': { maxAgeMs: HOUR }, ECB: { maxAgeMs: 120*HOUR },
  'NASA-EONET': { maxAgeMs: 72*HOUR }, RIPEstat: { maxAgeMs: 8*HOUR },
  'FIRST-EPSS': { maxAgeMs: 48*HOUR }, 'MET-Norway': { maxAgeMs: 8*HOUR },
  OONI: { maxAgeMs: 24*HOUR },
  'IMF-PortWatch': { maxAgeMs: 240*HOUR, observationMaxAgeMs: 240*HOUR },
  EMSC: { maxAgeMs: 12*HOUR, observationMaxAgeMs: 26*HOUR },
  'Copernicus-EMS': { maxAgeMs: 1080*HOUR, observationMaxAgeMs: 720*HOUR },
  'Aviation-SIGMET': { maxAgeMs: 3*HOUR, observationMaxAgeMs: 24*HOUR },
  'ADSB-Military': { maxAgeMs: 25*60000, observationMaxAgeMs: 25*60000 },
  'OpenSanctions-Index': { maxAgeMs: 48*HOUR, observationMaxAgeMs: 336*HOUR },
  'Federal-Register': { maxAgeMs: 336*HOUR, observationMaxAgeMs: 336*HOUR },
  'Energy-Charts-HU': { maxAgeMs: 6*HOUR, observationMaxAgeMs: 6*HOUR },
  'ENTSOG-HU': { maxAgeMs: 72*HOUR, observationMaxAgeMs: 72*HOUR },
  'Prediction-Markets': { maxAgeMs: 12*HOUR, observationMaxAgeMs: 12*HOUR },
  ThreatFox: { maxAgeMs: 6*HOUR, observationMaxAgeMs: 24*HOUR },
  HIBP: { maxAgeMs: 336*HOUR, observationMaxAgeMs: 720*HOUR },
  GPSJam: { maxAgeMs: 96*HOUR, observationMaxAgeMs: 96*HOUR },
  'WMO-SWIC': { maxAgeMs: 3*HOUR, observationMaxAgeMs: 24*HOUR },
  'UNHCR-Arrivals': { maxAgeMs: 504*HOUR, observationMaxAgeMs: 1440*HOUR },
  'SEC-8K': { maxAgeMs: 2160*HOUR, observationMaxAgeMs: 2160*HOUR },
  'Open-Meteo-Wind': { maxAgeMs: 3*HOUR, observationMaxAgeMs: 3*HOUR },
  'ADSB-Orbits': { maxAgeMs: 25*60000, observationMaxAgeMs: 25*60000 },
  'NOAA-NHC': { maxAgeMs: 8*HOUR, observationMaxAgeMs: 12*HOUR },
  'JMA-Typhoon': { maxAgeMs: 8*HOUR, observationMaxAgeMs: 12*HOUR },
  'ECDC-Threats': { maxAgeMs: 336*HOUR, observationMaxAgeMs: 504*HOUR },
  'Central-Banks': { maxAgeMs: 336*HOUR, observationMaxAgeMs: 2880*HOUR },
  'CFTC-COT': { maxAgeMs: 288*HOUR, observationMaxAgeMs: 288*HOUR },
  'FAA-Airports': { maxAgeMs: 3*HOUR, observationMaxAgeMs: 3*HOUR },
  Regulators: { maxAgeMs: 168*HOUR, observationMaxAgeMs: 336*HOUR },
  'Launch-Library': { maxAgeMs: 12*HOUR, observationMaxAgeMs: 720*HOUR },
});

// Never use collection time as a replacement for a missing provider date.
export function providerTime(raw, { assumeUTC = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 128) return null;
  let value = raw.trim();
  if (assumeUTC && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(value)) value += 'Z';
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/);
  let day;
  if (iso) {
    day = iso[1];
    if (iso[2] && (Number(iso[2])>23 || Number(iso[3])>59 || Number(iso[4])>59)) return null;
    if (iso[5] !== undefined && iso[5] !== 'Z' && (Number(iso[5].slice(1,3))>23 || Number(iso[5].slice(4))>59)) return null;
  } else {
    const rfc = value.match(/^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(?:GMT|UTC|[+-]\d{4})$/);
    if (!rfc || Number(rfc[4])>23 || Number(rfc[5])>59 || Number(rfc[6])>59) return null;
    const zone=value.match(/([+-])(\d{2})(\d{2})$/);
    if (zone && (Number(zone[2])>23 || Number(zone[3])>59)) return null;
    const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(rfc[2].toLowerCase())+1;
    if (!month) return null;
    day = `${rfc[3]}-${String(month).padStart(2,'0')}-${rfc[1].padStart(2,'0')}`;
  }
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0,10)!==day) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function freshness(time, maxAgeMs, now = Date.now()) {
  const observedAt = providerTime(time);
  const ageMs = observedAt ? now - Date.parse(observedAt) : null;
  const fresh = Number.isFinite(ageMs) && Number.isFinite(maxAgeMs) && ageMs >= -300000 && ageMs <= maxAgeMs;
  return { observedAt, maxAgeMs, ageMs, fresh, reason: fresh ? null : ageMs === null ? 'unknown-provider-time' : ageMs < -300000 ? 'future-provider-time' : 'expired-provider-time' };
}

export function freshResult(source, observedAt, observations = [], extras = {}, now = Date.now()) {
  const policy = POLICIES[source];
  if (!policy) throw new Error('Unknown freshness policy');
  const state = freshness(observedAt, policy.maxAgeMs, now);
  const rows = state.fresh && Array.isArray(observations) ? observations.slice(0,100).filter(row => {
    if (!row || typeof row !== 'object') return false;
    const time = row.observedAt || row.publishedAt;
    if (!freshness(time, policy.observationMaxAgeMs || policy.maxAgeMs, now).fresh) return false;
    if (row.validUntil !== undefined && (!providerTime(row.validUntil) || Date.parse(row.validUntil) <= now)) return false;
    if (source === 'MET-Norway' || row.kind === 'forecast') {
      const target = providerTime(row.forecastAt), until = providerTime(row.validUntil);
      if (!target || !until || Math.abs(Date.parse(target)-now)>HOUR || Date.parse(until)<=Date.parse(target) || Date.parse(until)-Date.parse(target)>12*HOUR || Date.parse(until)<=now) return false;
    }
    return true;
  }) : [];
  if (source === 'MET-Norway' && !rows.length) { state.fresh=false;state.reason='expired-or-unknown-forecast'; }
  return { ...extras, source, timestamp: new Date(now).toISOString(), observedAt: state.observedAt,
    status: state.fresh ? 'ok' : 'stale', stale: !state.fresh, freshness: state,
    observations: rows, rejectedObservations: Array.isArray(observations) ? Math.min(100, observations.length)-rows.length : 0 };
}

export function unavailableResult(source, error, extras = {}, now = Date.now()) {
  return { ...freshResult(source, null, [], extras, now), status: 'error', stale: false, error: String(error).slice(0,300) };
}
