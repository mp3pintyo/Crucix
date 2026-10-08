import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import express from 'express';

const JSON_BODY_LIMIT = '8kb';

// Pages that may be framed when EMBED_ORIGINS is set; everything else stays X-Frame-Options: DENY.
const EMBEDDABLE_PATHS = new Set(['/', '/embed.html']);

/**
 * Opt-in cross-origin READ access to the JSON API (CORS_ORIGINS). Only GET/HEAD requests and the preflight of a GET get
 * Access-Control-* headers, and only under /api; a state-changing request never does (the preflight of a POST/PUT/DELETE
 * is not granted, as before). No credentials mode is granted: a page calls an authenticated server by sending the
 * Authorization header itself, which the preflight allows. Installed before the Basic auth so the preflight (which
 * carries no credentials) is answered.
 * @param {string[]} origins allowed origins, or ['*']
 * @returns {import('express').RequestHandler}
 */
export function corsReadOnly(origins) {
  const any = origins.includes('*');
  const READ = new Set(['GET', 'HEAD']);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin === undefined || !(any || origins.includes(origin.toLowerCase()))) return next();
    const preflight = req.method === 'OPTIONS' && READ.has((req.get('access-control-request-method') || '').toUpperCase());
    if (!READ.has(req.method) && !preflight) return next();
    res.set('Access-Control-Allow-Origin', any ? '*' : origin);
    if (!any) res.vary('Origin');
    if (!preflight) return next();
    res.set({ 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '600' });
    res.status(204).end();
  };
}

// Whether Basic auth is on is kept in app.locals.authRequired: requireSameOriginJson reads it to decide on the host check.
// `web` = {corsOrigins, embedOrigins} (see crucix.config.mjs); both empty leaves the headers exactly as before.
export function installHttpSecurity(app, { user = '', password = '' } = {}, { corsOrigins = [], embedOrigins = [] } = {}) {
  if (Boolean(user) !== Boolean(password)) throw new Error('Set both AUTH_USER and AUTH_PASSWORD, or neither.');
  if (user.includes(':')) throw new Error('AUTH_USER cannot contain a colon.');
  const digest = value => createHash('sha256').update(value).digest();
  const expected = user ? digest(`${user}:${password}`) : null;
  app.locals.authRequired = expected !== null;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (embedOrigins.length > 0 && EMBEDDABLE_PATHS.has(req.path)) {
      res.removeHeader('X-Frame-Options');
      res.set('Content-Security-Policy', `frame-ancestors 'self' ${embedOrigins.join(' ')}`);
    }
    next();
  });
  if (corsOrigins.length > 0) app.use('/api', corsReadOnly(corsOrigins));
  // Readiness probes expose no intelligence, credentials, or configuration.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  if (!expected) return;
  app.use((req, res, next) => {
    const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(req.get('authorization') || '');
    const credentials = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
    if (match && timingSafeEqual(expected, digest(credentials))) return next();
    res.set('WWW-Authenticate', 'Basic realm="Crucix", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required' });
  });
}

const refuse = (res, status, code, error) => res.status(status).json({ error, code, field: null });

// The Host header: a host name or IPv4 address, or a bracketed IPv6 address, with an optional port.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

function hostnameOf(req) {
  const match = HOST_HEADER.exec(req.get('host') || '');
  return match ? match[1].toLowerCase() : null;
}

// Host names a DNS-rebinding page can never use: IP addresses, and localhost / *.localhost, which browsers resolve
// to this machine themselves.
function isLocalOrAddress(hostname) {
  if (hostname.startsWith('[')) return isIP(hostname.slice(1, -1)) === 6;
  return isIP(hostname) === 4 || hostname === 'localhost' || hostname.endsWith('.localhost');
}

// An http(s) URL's origin and host name, or nulls.
function publicSite(publicUrl) {
  try {
    const url = new URL(publicUrl);
    return ['http:', 'https:'].includes(url.protocol) ? { origin: url.origin, hostname: url.hostname.toLowerCase() } : null;
  } catch {
    return null;
  }
}

// The page's own origin. The https form of the same host is accepted too: behind a TLS-terminating reverse proxy the
// server itself sees plain http while the browser sends its https origin. So is the ALERT_PUBLIC_URL origin, for a
// proxy that rewrites Host (nginx sends its upstream's address by default).
function isSameOrigin(req, origin, publicOrigin) {
  const host = req.get('host')?.toLowerCase();
  return (host !== undefined && (origin === `${req.protocol}://${host}` || origin === `https://${host}`)) || origin === publicOrigin;
}

/**
 * Guard for state-changing routes. A browser re-sends cached Basic credentials with any page's requests, so the
 * authentication alone does not stop a cross-site request. Here the body must be JSON (415), a request with an
 * `Origin` must come from this origin (or `publicUrl`'s) and one with `Sec-Fetch-Site` from `same-origin` or `none`
 * (403 CROSS_ORIGIN). Without Basic auth a DNS-rebinding page is same-origin by construction, so the Host must also be
 * an IP address, localhost, *.localhost, the `publicUrl` host or one of `allowedHosts` (403 HOST_NOT_ALLOWED); with
 * Basic auth a rebound page has no credentials and this check is skipped. Then the body is parsed: at most 8 KB (413)
 * and well-formed JSON (400). Every refusal is JSON and comes before the route runs.
 * A request with neither header (curl, scripts) passes on its JSON Content-Type: a browser cannot send that cross-site
 * without a CORS preflight, which this server never grants.
 * @param {{publicUrl?: string|null, allowedHosts?: string[]}} [options] ALERT_PUBLIC_URL and ALERT_ALLOWED_HOSTS
 * @returns {import('express').RequestHandler}
 */
export function requireSameOriginJson({ publicUrl = null, allowedHosts = [] } = {}) {
  const parse = express.json({ limit: JSON_BODY_LIMIT, type: 'application/json' });
  const site = publicSite(publicUrl);
  const hosts = new Set((Array.isArray(allowedHosts) ? allowedHosts : []).filter(host => typeof host === 'string').map(host => host.toLowerCase()));
  if (site !== null) hosts.add(site.hostname);
  return (req, res, next) => {
    const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return refuse(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if ((origin !== undefined && !isSameOrigin(req, origin, site?.origin)) || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
      return refuse(res, 403, 'CROSS_ORIGIN', 'Cross-origin request refused');
    }
    if (req.app?.locals?.authRequired !== true) {
      const hostname = hostnameOf(req);
      if (hostname === null || !(isLocalOrAddress(hostname) || hosts.has(hostname))) {
        return refuse(res, 403, 'HOST_NOT_ALLOWED', 'This host name may not change alerts; set ALERT_PUBLIC_URL or ALERT_ALLOWED_HOSTS');
      }
    }
    parse(req, res, error => {
      if (!error) return next();
      if (error.status === 413) return refuse(res, 413, 'BODY_TOO_LARGE', 'The request body is larger than 8 KB');
      if (error.status === 415) return refuse(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported body encoding or charset');
      refuse(res, 400, 'INVALID_JSON', 'The request body is not valid JSON');
    });
  };
}
