// IODA — Internet Outage Detection and Analysis
// No auth required. Tracks macroscopic Internet outages at country level.
// Useful for monitoring censorship, state shutdowns, and wartime disruption.

import { safeFetch } from '../utils/fetch.mjs';

const API_BASE = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const WINDOW_DAYS = 14;
const SUMMARY_LIMIT = 40;
const EVENT_LIMIT = 60;
const DEFAULT_EXTEND_WINDOW = 14 * 24 * 60 * 60;

function epochSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function isoFromEpoch(seconds) {
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

function buildUrl(path, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    query.set(key, String(value));
  }
  return `${API_BASE}${path}?${query.toString()}`;
}

async function fetchOutageSummary(from, until) {
  const url = buildUrl('/outages/summary', {
    entityType: 'country',
    from,
    until,
    limit: SUMMARY_LIMIT,
    orderBy: 'score/desc',
    extendWindow: DEFAULT_EXTEND_WINDOW,
  });
  const data = await safeFetch(url, { timeout: 20000, retries: 1 });
  if (data.error) return { error: data.error };
  return data.data || [];
}

async function fetchOutageEvents(from, until) {
  const url = buildUrl('/outages/events', {
    entityType: 'country',
    from,
    until,
    limit: EVENT_LIMIT,
    orderBy: 'time/desc',
    format: 'codf',
    extendWindow: DEFAULT_EXTEND_WINDOW,
  });
  const data = await safeFetch(url, { timeout: 20000, retries: 1 });
  if (data.error) return { error: data.error };
  return data.data || [];
}

function normalizeSummary(item) {
  return {
    countryCode: item.entity?.code || null,
    country: item.entity?.name || item.entity?.code || 'Unknown',
    eventCount: item.event_cnt || 0,
    overallScore: item.scores?.overall || 0,
    scores: item.scores || {},
  };
}

function normalizeEvent(item, nowEpoch) {
  const [, countryCode] = String(item.location || '').split('/');
  const start = item.start || 0;
  const duration = item.duration || 0;
  const end = start + duration;
  return {
    countryCode: countryCode || null,
    country: item.location_name || countryCode || 'Unknown',
    start,
    end,
    startIso: isoFromEpoch(start),
    endIso: isoFromEpoch(end),
    durationSeconds: duration,
    datasource: item.datasource || 'overall',
    method: item.method || 'unknown',
    status: item.status ?? null,
    score: item.score || 0,
    overlapsWindow: Boolean(item.overlaps_window),
    active: end > nowEpoch,
  };
}

function buildCountryRollup(summaryItems, eventItems) {
  const countries = new Map();

  for (const summary of summaryItems) {
    countries.set(summary.countryCode || summary.country, {
      countryCode: summary.countryCode,
      country: summary.country,
      eventCount: summary.eventCount,
      activeCount: 0,
      overallScore: summary.overallScore,
      scores: summary.scores,
      lastStart: null,
      topDatasource: null,
      datasources: {},
    });
  }

  for (const event of eventItems) {
    const key = event.countryCode || event.country;
    const hadSummary = countries.has(key);
    if (!hadSummary) {
      countries.set(key, {
        countryCode: event.countryCode,
        country: event.country,
        eventCount: 0,
        activeCount: 0,
        overallScore: 0,
        scores: {},
        lastStart: null,
        topDatasource: null,
        datasources: {},
      });
    }

    const row = countries.get(key);
  if (!hadSummary) row.eventCount += 1;
    row.activeCount += event.active ? 1 : 0;
    row.overallScore = Math.max(row.overallScore, event.score || 0);
    row.lastStart = !row.lastStart || new Date(event.startIso) > new Date(row.lastStart)
      ? event.startIso
      : row.lastStart;
    row.datasources[event.datasource] = (row.datasources[event.datasource] || 0) + 1;
  }

  for (const row of countries.values()) {
    row.topDatasource = Object.entries(row.datasources)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'overall';
    delete row.datasources;
  }

  return Array.from(countries.values())
    .sort((a, b) => {
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
      if (b.overallScore !== a.overallScore) return b.overallScore - a.overallScore;
      return b.eventCount - a.eventCount;
    })
    .slice(0, 20);
}

function buildSignals(countries, events) {
  const signals = [];
  const activeCountries = countries.filter(country => country.activeCount > 0);
  const multiEventCountries = countries.filter(country => country.eventCount >= 3);
  const severeCountry = countries[0];

  if (activeCountries.length > 0) {
    const label = activeCountries.slice(0, 4).map(country => country.country).join(', ');
    signals.push({
      severity: 'high',
      signal: `Active country-level internet outages detected in ${label}`,
    });
  }

  if (multiEventCountries.length >= 3) {
    signals.push({
      severity: 'medium',
      signal: `${multiEventCountries.length} countries recorded 3+ outage events in the last ${WINDOW_DAYS} days`,
    });
  }

  if (severeCountry && severeCountry.overallScore >= 2500) {
    signals.push({
      severity: severeCountry.activeCount > 0 ? 'high' : 'medium',
      signal: `${severeCountry.country} shows elevated outage severity (score ${Math.round(severeCountry.overallScore)})`,
    });
  }

  const recentShutdowns = events.filter(event => event.durationSeconds >= 3600 * 6).length;
  if (recentShutdowns >= 3) {
    signals.push({
      severity: 'medium',
      signal: `${recentShutdowns} prolonged country-level outage events exceeded 6 hours in the current window`,
    });
  }

  return signals;
}

export async function briefing() {
  const now = new Date();
  const until = epochSeconds(now);
  const from = until - WINDOW_DAYS * 24 * 60 * 60;

  const [summaryResponse, eventsResponse] = await Promise.all([
    fetchOutageSummary(from, until),
    fetchOutageEvents(from, until),
  ]);

  if (summaryResponse?.error && eventsResponse?.error) {
    return {
      source: 'IODA',
      timestamp: now.toISOString(),
      error: summaryResponse.error || eventsResponse.error,
    };
  }

  const summaryItems = Array.isArray(summaryResponse)
    ? summaryResponse.map(normalizeSummary)
    : [];
  const eventItems = Array.isArray(eventsResponse)
    ? eventsResponse.map(item => normalizeEvent(item, until))
    : [];

  const affectedCountries = buildCountryRollup(summaryItems, eventItems);
  const activeEvents = eventItems.filter(event => event.active).length;
  const signals = buildSignals(affectedCountries, eventItems);

  return {
    source: 'IODA',
    timestamp: now.toISOString(),
    window: {
      from: isoFromEpoch(from),
      until: isoFromEpoch(until),
      days: WINDOW_DAYS,
    },
    outages: {
      totalEvents: eventItems.length,
      activeEvents,
      affectedCountries,
      recentEvents: eventItems.slice(0, 20),
      summary: summaryItems.slice(0, 20),
    },
    signals,
  };
}

if (process.argv[1]?.endsWith('ioda.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}