/* Crucix browser intelligence workspace. No runtime dependency; untrusted data
 * is always a text node. APIs remain same-origin, authenticated and uncached. */
(function (window, document) {
  'use strict';

  const COPY = {
    listCount: 'Showing {shown} of {total} events.',
    kind_signal: 'Signal', kind_interference: 'GNSS interference', kind_displacement: 'Displacement', kind_disaster: 'Natural event', 'kind_space-weather': 'Space weather', kind_economic: 'Economy / reference rate', kind_forecast: 'Forecast', kind_cyber: 'Cyber risk', kind_aviation: 'Aviation', kind_sanctions: 'Sanctions', kind_market: 'Prediction market', kind_energy: 'Energy', severity_unknown: 'Unknown', severity_monitor: 'Monitor', severity_low: 'Low', severity_moderate: 'Moderate', severity_elevated: 'Elevated', severity_high: 'High', severity_critical: 'Critical',
    'method_centroid': 'Mean position of the affected areas (aggregate, not a single point)', 'method_member-point': 'Point of the issuing national service (not the affected area)', 'method_headline-keyword': 'Estimated from headline keywords', 'method_text-keyword': 'Estimated from report keywords', 'method_country-centroid': 'Country centroid estimate', 'method_who-region-centroid': 'WHO region centroid estimate', 'method_forecast-grid': 'Forecast grid point', 'method_configured-point': 'Configured forecast location', 'method_theater-centre': 'Centre of the watched area (aggregate, not a position)', 'method_polygon-centroid': 'Centre of the provider’s area (polygon centroid)', 'method_polygon-vertex-mean': 'Approximate centre of the provider’s area (mean of its points)', method_global: 'Global (no single location)',
    checkLocationMethod: 'Valid coordinates and known location method', checkSourceAvailable: 'Source available',
    close: 'Close', details: 'Event details', unknown: 'Unknown', source: 'Source', originalSource: 'Open original source', sourceUnavailable: 'Original source link unavailable', kind: 'Type', severity: 'Severity', observed: 'Observed', published: 'Published', collected: 'Collected', location: 'Location', coordinates: 'Coordinates', locationMethod: 'Location method', locationPrecision: 'Location precision', sourceHealth: 'Source health', quality: 'Metadata completeness', qualityHelp: 'These checks describe available source, time and location metadata. They do not establish whether a report is true.', qualityComplete: 'Complete metadata', qualityPartial: 'Partial metadata', qualityMinimal: 'Minimal metadata', checkLink: 'Original source URL', checkTime: 'Provider observation or publication time', checkLocation: 'Valid location coordinates', checkSourceState: 'Known source health', checkPresent: 'Available', checkMissing: 'Missing', relatedReports: 'Related reports', relatedHelp: 'Similarity in title, place or time does not confirm the same event. Reports from a shared feed are not independent evidence.', noRelated: 'No related reports available', eventUnavailable: 'This event is unavailable.', loading: 'Loading…', backHistory: 'Back to history', events: 'Events', noEvents: 'No events available', history: 'Event history', search: 'Search', allKinds: 'All types', allSources: 'Any source', from: 'Collected from (UTC)', to: 'Collected through (UTC)', pageSize: 'Events per page', clearFilters: 'Clear filters', results: '{count} matching events', page: 'Page {page} of {pages}', previous: 'Previous', next: 'Next', historyLoading: 'Loading history…', historyEmpty: 'No events match these filters.', historyError: 'Could not load event history.', offline: 'Offline. History requires a connection to the local server.', retry: 'Retry', summary: 'Collection timeline · UTC', summaryScope: 'Counts cover all events matching the current filters.', summaryPage: 'Counts cover this page.', unknownTime: 'Unknown time', export: 'Export filtered events', exportHelp: 'Exports include up to 2,000 matching events. The report indicates when results are truncated.', exportJSON: 'JSON', exportCSV: 'CSV', exportHTML: 'Print / PDF', exportSTIX: 'STIX 2.1', exportPrintHelp: 'Open the HTML report, then choose Print → Save as PDF in your browser.', exportBlocked: 'Allow a new tab to open the printable report.', profiles: 'Workspace profiles', profilesHelp: 'Profiles save panels, map layers and region. Your custom view remains available when switching presets.', research: 'Research', researchCopy: 'News, related signals and source metadata.', market: 'Markets', marketCopy: 'Market data, trade ideas and maritime layers.', infrastructure: 'Infrastructure', infrastructureCopy: 'Internet, energy, health and transport layers.', custom: 'Custom view', customCopy: 'Your view before applying a profile.', savedProfiles: 'Saved profiles', noProfiles: 'No saved profiles yet.', profileName: 'Profile name', saveProfile: 'Save current view', renameProfile: 'Save new name', apply: 'Apply', rename: 'Rename', delete: 'Delete', cancel: 'Cancel', profileLimit: 'You can save up to 12 profiles. Delete one to save another.', profileNameRequired: 'Enter a name for the profile.', profileSaved: 'Profile saved.', profileRenamed: 'Profile renamed.', profileDeleted: 'Profile deleted.', profileApplied: 'Profile applied.', profileError: 'Could not apply this profile.', sessionStorage: 'Browser storage is unavailable. Profiles remain available for this session.', profileCount: '{count} of 12 saved profiles', cluster: 'Grouped reports', clusterHelp: 'These reports share a geographic cell and time window. Geographic proximity alone does not establish event identity.', kind_news: 'News', kind_earthquake: 'Earthquake', kind_health: 'Health', kind_outage: 'Internet outage', kind_network: 'Internet outage', kind_conflict: 'Conflict', kind_weather: 'Weather', kind_thermal: 'Thermal / fire', kind_air: 'Air activity', kind_osint: 'OSINT', kind_maritime: 'Maritime', kind_nuclear: 'Nuclear / radiation', kind_space: 'Space', status_ok: 'Available', status_error: 'Error', status_stale: 'Stale', status_disabled: 'Disabled', status_unknown: 'Unknown', method_exact: 'Provider coordinates', method_provider: 'Provider coordinates', method_inferred: 'Inferred from report metadata', method_geocoded: 'Geocoded', method_region: 'Region estimate', method_unknown: 'Unknown', precision_exact: 'Exact', precision_approximate: 'Approximate', precision_city: 'City', precision_region: 'Region', precision_country: 'Country', precision_unknown: 'Unknown'
  };
  const DEFAULT_ZONES = {
    left: ['sensorGrid', 'nuclearWatch', 'riskGauges', 'spaceWatch'], center1: ['newsTicker'], center2: ['macroMarkets'], center3: ['tradeIdeas'], right: ['changes', 'countryRisk', 'crossSourceSignals', 'osintStream', 'signalCore', 'sourceHealth', 'internetOutages', 'healthAlerts', 'supplementalHealth', 'sweepDelta', 'liveSources']
  };
  const ZONES = Object.keys(DEFAULT_ZONES), PANELS = Object.values(DEFAULT_ZONES).flat();
  // Panels a saved layout or profile that never held them gets at the top of their default rail (after the top panels already
  // leading it, as in jarvis.html), not at the end.
  const TOP_PANELS = ['changes', 'countryRisk'];
  const LAYERS = ['air', 'thermal', 'sdr', 'maritime', 'nuclear', 'conflict', 'osint', 'health', 'network', 'news', 'weather', 'space', 'earthquake', 'disaster', 'interference', 'pipelines', 'bases'];
  const LAYERS_OFF = ['pipelines', 'bases'];
  const EVENT_KINDS = ['news', 'osint', 'health', 'earthquake', 'weather', 'outage', 'conflict', 'signal', 'disaster', 'space-weather', 'economic', 'forecast', 'network', 'cyber', 'maritime', 'aviation', 'sanctions', 'market', 'energy', 'interference', 'displacement'];
  const REGIONS = ['world', 'americas', 'europe', 'middleEast', 'asiaPacific', 'africa'];
  const STORAGE_KEY = 'crucix_workspace_profiles_v1', MAX_PROFILES = 12, MAX_STORAGE = 128 * 1024;
  let options = {}, snapshot = { events: [] }, pushedSnapshot = false, overlay, dialog, content, heading, priorFocus, priorOverflow;
  let inertNodes = [], mode = '', detailId = null, detailVersion = 0, detailController;
  let historyVersion = 0, historyController, historyTimer, historyResult = null, historyNodes = {}, returnToHistory = false;
  const filters = { q: '', kind: '', source: '', from: '', to: '', limit: 50, offset: 0 };
  let profiles = [], customState = null, lastAppliedState = null, storageUnavailable = false, editingId = null, profileMessage = '', profileSerial = 0;

  function bounded(value, limit = 500) { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit) : ''; }
  function tr(key, substitutions) {
    let value = options.t?.('intelligence.' + key, COPY[key] || key) || COPY[key] || key;
    if (typeof value !== 'string') value = COPY[key] || key;
    if (substitutions) for (const [name, text] of Object.entries(substitutions)) value = value.split('{' + name + '}').join(String(text));
    return value;
  }
  // A sweep replay (replay.js) shows an archived snapshot; /api/history, /api/export and /api/events/:id read the live store, so
  // those requests are off while it runs and the dialog says why (the text is replay.js's). Records of the replayed snapshot
  // itself still open.
  function replaying() { try { return !!window.CrucixReplay?.active?.(); } catch { return false; } }
  function replayNote() { let value = ''; try { value = window.CrucixReplay?.historyNote?.(); } catch { value = ''; } return typeof value === 'string' && value ? value : tr('eventUnavailable'); }
  function label(prefix, value) { const code = bounded(value, 100); return COPY[prefix + '_' + code] ? tr(prefix + '_' + code) : code || tr('unknown'); }
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function button(text, action, className = 'ci-button') { const node = element('button', className, text); node.type = 'button'; if (action) node.addEventListener('click', action); return node; }
  function safeUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      if ([...url.searchParams.keys()].some(key => /^(?:access[-_]?token|refresh[-_]?token|api[-_]?key|token|secret|password|authorization|auth|signature)$/i.test(key))) return null;
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function validCoordinates(value) { return value && typeof value.lat === 'number' && typeof value.lon === 'number' && Number.isFinite(value.lat) && Number.isFinite(value.lon) && Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180; }
  function validTime(value) { return typeof value === 'string' && value.length < 100 && Number.isFinite(Date.parse(value)); }
  function time(value) { if (!validTime(value)) return tr('unknown'); return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'); }
  function sourceLink(source) {
    const url = safeUrl(source?.url); if (!url) return null;
    const link = element('a', 'ci-source-link', tr('originalSource')); link.href = url; link.target = '_blank'; link.setAttribute('rel', 'noopener noreferrer'); return link;
  }
  function allEvents() {
    let current; try { current = pushedSnapshot ? snapshot : options.getSnapshot?.() || snapshot; } catch { current = snapshot; }
    return Array.isArray(current?.events) ? current.events.slice(0, 10000) : [];
  }
  function focusable() {
    if (!dialog) return [];
    return [...dialog.querySelectorAll('button,a,input,select,textarea,[tabindex]')].filter(node => !node.disabled && !node.hidden && node.getAttribute('tabindex') !== '-1' && (node.tagName !== 'A' || node.href));
  }
  function keydown(event) {
    if (!overlay) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusable(), first = nodes[0], last = nodes[nodes.length - 1];
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  function keepFocus(event) { if (overlay && !dialog.contains(event.target)) (focusable()[0] || dialog).focus(); }
  function stopHistory() { clearTimeout(historyTimer); historyTimer = null; historyVersion++; historyController?.abort(); historyController = null; }
  function close() {
    if (!overlay) return;
    stopHistory(); detailVersion++; detailController?.abort(); detailController = null;
    document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', keepFocus, true);
    overlay.remove(); overlay = dialog = content = heading = null; mode = ''; detailId = null;
    for (const [node, wasInert] of inertNodes) node.inert = wasInert;
    inertNodes = []; document.body.style.overflow = priorOverflow;
    const restoreFocus = priorFocus?.isConnected ? priorFocus : priorFocus?.id ? document.getElementById(priorFocus.id) : null;
    restoreFocus?.focus({ preventScroll: true }); priorFocus = null;
  }
  function show(view, title) {
    if (view !== 'history') stopHistory();
    if (!overlay) {
      priorFocus = document.activeElement; priorOverflow = document.body.style.overflow;
      overlay = element('div', 'ci-overlay'); overlay.id = 'ci-overlay';
      dialog = element('section', 'ci-dialog'); dialog.id = 'ci-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'ci-title'); dialog.setAttribute('tabindex', '-1');
      const header = element('header', 'ci-header'); heading = element('h2', 'ci-title'); heading.id = 'ci-title';
      const closeButton = button(tr('close'), close, 'ci-button ci-close'); closeButton.id = 'ci-close'; closeButton.setAttribute('aria-label', tr('close'));
      header.append(heading, closeButton); content = element('div', 'ci-body'); content.id = 'ci-body'; dialog.append(header, content); overlay.appendChild(dialog);
      inertNodes = [...document.body.children].map(node => [node, !!node.inert]); for (const [node] of inertNodes) node.inert = true;
      document.body.appendChild(overlay); document.body.style.overflow = 'hidden';
      overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
      document.addEventListener('keydown', keydown, true); document.addEventListener('focusin', keepFocus, true);
    }
    mode = view; overlay.dataset.ciView = view; heading.textContent = bounded(title, 500); content.replaceChildren(); content.scrollTop = 0;
    document.getElementById('ci-close').focus({ preventScroll: true }); return content;
  }
  function paragraph(text, className = 'ci-help') { return element('p', className, text); }
  function infoRow(list, key, value) { list.append(element('dt', '', tr(key)), element('dd', '', value || tr('unknown'))); }
  function status(text, error = false) { const node = paragraph(text, 'ci-status' + (error ? ' ci-error' : '')); node.setAttribute('role', error ? 'alert' : 'status'); return node; }
  function renderDetail(record) {
    const data = record && typeof record === 'object' ? record : {}, body = show('detail', bounded(data.title, 500) || tr('details'));
    detailId = bounded(data.id, 128);
    if (returnToHistory && options.historyEnabled) body.appendChild(button(tr('backHistory'), openHistory, 'ci-button ci-back'));
    const meta = element('p', 'ci-event-meta', [label('kind', data.kind), bounded(data.source?.name, 160)].filter(Boolean).join(' · ')); body.appendChild(meta);
    if (data.summary) body.appendChild(paragraph(bounded(data.summary, 8000), 'ci-summary'));
    const original = sourceLink(data.source); body.appendChild(original || paragraph(tr('sourceUnavailable')));
    const list = element('dl', 'ci-metadata');
    infoRow(list, 'source', bounded(data.source?.name, 160)); infoRow(list, 'sourceHealth', label('status', data.source?.status));
    infoRow(list, 'observed', time(data.observedAt)); infoRow(list, 'published', time(data.publishedAt)); infoRow(list, 'collected', time(data.collectedAt));
    for (const key of ['forecastAt','startsAt','validUntil']) if (data[key]) infoRow(list,key,time(data[key]));
    infoRow(list, 'location', bounded(data.location?.label, 300)); infoRow(list, 'coordinates', validCoordinates(data.location) ? data.location.lat.toFixed(4) + ', ' + data.location.lon.toFixed(4) : tr('unknown'));
    infoRow(list, 'locationMethod', label('method', data.location?.method)); infoRow(list, 'locationPrecision', label('precision', data.location?.precision));
    if (data.severity) infoRow(list, 'severity', label('severity', data.severity)); body.appendChild(list);
    const checks = [ ['checkLink', !!safeUrl(data.source?.url)], ['checkTime', validTime(data.observedAt) || validTime(data.publishedAt)], ['checkLocationMethod', validCoordinates(data.location) && !!data.location.method && data.location.method !== 'unknown'], ['checkSourceAvailable', data.source?.status === 'ok'] ];
    const count = checks.filter(([, available]) => available).length, quality = count === 4 ? 'qualityComplete' : count >= 2 ? 'qualityPartial' : 'qualityMinimal';
    const section = element('section', 'ci-section'); section.append(element('h3', '', tr('quality')), paragraph(tr(quality), 'ci-quality-label'), paragraph(tr('qualityHelp')));
    const checkList = element('ul', 'ci-checks'); for (const [key, available] of checks) { const item = element('li', available ? 'ci-check-present' : 'ci-check-missing'); item.append(element('span', '', tr(key)), element('span', '', tr(available ? 'checkPresent' : 'checkMissing'))); checkList.appendChild(item); } section.appendChild(checkList); body.appendChild(section);
    const related = element('section', 'ci-section'); related.append(element('h3', '', tr('relatedReports')), paragraph(tr('relatedHelp')));
    const reports = Array.isArray(data.relatedSources) ? data.relatedSources.filter(report => report && typeof report === 'object').slice(0, 8) : [];
    if (!reports.length) related.appendChild(paragraph(tr('noRelated')));
    for (const report of reports) {
      const eventId = bounded(report.eventId || report.id, 128), found = allEvents().find(item => item?.id === eventId), title = bounded(found?.title || report.title || report.name || report.source?.name, 500) || tr('details');
      const card = element('div', 'ci-related-card');
      if (eventId) { const open = button(title, () => openEvent(eventId), 'ci-result-title'); open.dataset.ciEventId = eventId; card.appendChild(open); } else card.appendChild(paragraph(title));
      const relatedSource = report.source || report, link = sourceLink(relatedSource); if (link) card.appendChild(link); related.appendChild(card);
    }
    body.appendChild(related);
  }
  async function openEvent(recordOrId) {
    const originHistory = mode === 'history' || returnToHistory && mode === 'detail'; returnToHistory = originHistory;
    const version = ++detailVersion; detailController?.abort(); detailController = null;
    let record = typeof recordOrId === 'object' && recordOrId ? recordOrId : allEvents().find(item => item?.id === recordOrId);
    if (record) { renderDetail(record); return true; }
    const id = bounded(recordOrId, 128);
    show('detail', tr('details')).appendChild(status(tr('loading')));
    if (replaying()) { content.replaceChildren(status(tr('eventUnavailable'), true), status(replayNote())); return false; }
    if (!options.historyEnabled || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) { content.replaceChildren(status(tr('eventUnavailable'), true)); return false; }
    detailController = new AbortController();
    try {
      const response = await window.fetch('/api/events/' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: detailController.signal });
      if (!response.ok) throw new Error('event response'); record = await response.json();
      if (version !== detailVersion || mode !== 'detail') return false;
      if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== id) throw new Error('invalid event'); renderDetail(record); return true;
    } catch { if (version === detailVersion && mode === 'detail') content.replaceChildren(status(tr('eventUnavailable'), true)); return false; }
  }
  function dateFilter(value, end) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''; const iso = value + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'); return validTime(iso) && new Date(iso).toISOString().slice(0, 10) === value ? iso : ''; }
  function queryString(includePagination = true) {
    const query = new URLSearchParams(); for (const key of ['q', 'kind', 'source']) if (filters[key]) query.set(key, filters[key]);
    for (const key of ['from', 'to']) { const value = dateFilter(filters[key], key === 'to'); if (value) query.set(key, value); }
    if (includePagination) { query.set('limit', String(filters.limit)); query.set('offset', String(filters.offset)); } return query;
  }
  function field(parent, key, node) { const wrapper = element('label', 'ci-field'); wrapper.append(element('span', '', tr(key)), node); parent.appendChild(wrapper); return node; }
  function filterChanged(key, value, delayed) {
    const normalized = key === 'limit' ? Math.max(1, Math.min(200, Number.parseInt(value, 10) || 50)) : bounded(value, key === 'q' ? 300 : key === 'source' ? 160 : 80);
    // A search input also commits on blur. Repeating its completed query would
    // collapse/recenter this dialog between pointer down and pointer up.
    if (normalized === filters[key] && !historyTimer) return;
    filters[key] = normalized;
    filters.offset = 0; clearTimeout(historyTimer); historyVersion++; historyController?.abort();
    if (delayed) historyTimer = setTimeout(() => fetchHistory(), 300); else fetchHistory();
  }
  function historyInput(parent, key, copyKey, type = 'search', delayed = false) {
    const input = element('input', 'ci-input'); input.id = 'ci-history-' + key; input.type = type; input.value = filters[key]; input.maxLength = key === 'q' ? 300 : 160;
    if (key === 'source') input.placeholder = tr('allSources'); input.addEventListener(type === 'search' ? 'input' : 'change', () => filterChanged(key, input.value, delayed));
    // Search fields support committed changes as well as debounced typing.
    if (type === 'search') input.addEventListener('change', () => filterChanged(key, input.value, false)); return field(parent, copyKey, input);
  }
  function openHistory() {
    if (!options.historyEnabled) return false;
    detailVersion++; detailController?.abort(); returnToHistory = false; detailId = null; stopHistory();
    if (replaying()) { show('history', tr('history')).appendChild(status(replayNote())); return true; }
    const body = show('history', tr('history')), form = element('form', 'ci-history-filters'); form.setAttribute('aria-label', tr('history'));
    form.addEventListener('submit', event => { event.preventDefault(); clearTimeout(historyTimer); filters.offset = 0; fetchHistory(); });
    historyInput(form, 'q', 'search', 'search', true);
    const kinds = new Set(EVENT_KINDS);
    const kind = element('select', 'ci-input'); kind.id = 'ci-history-kind'; const any = element('option', '', tr('allKinds')); any.value = ''; kind.appendChild(any);
    for (const value of [...kinds].sort().slice(0, 80)) { const opt = element('option', '', label('kind', value)); opt.value = value; kind.appendChild(opt); } kind.value = filters.kind;
    kind.addEventListener('change', () => filterChanged('kind', kind.value, false)); field(form, 'kind', kind);
    historyInput(form, 'source', 'source'); historyInput(form, 'from', 'from', 'date'); historyInput(form, 'to', 'to', 'date');
    const limit = element('input', 'ci-input'); limit.id = 'ci-history-limit'; limit.type = 'number'; limit.min = '1'; limit.max = '200'; limit.value = String(filters.limit); limit.addEventListener('change', () => { filterChanged('limit', limit.value, false); limit.value = String(filters.limit); }); field(form, 'pageSize', limit);
    const clear = button(tr('clearFilters'), () => { Object.assign(filters, { q: '', kind: '', source: '', from: '', to: '', limit: 50, offset: 0 }); openHistory(); }); form.appendChild(clear); body.appendChild(form);
    const exportSection = element('section', 'ci-export ci-section'); exportSection.append(element('h3', '', tr('export')), paragraph(tr('exportHelp')));
    const exports = element('div', 'ci-actions'); for (const [format, key] of [['json', 'exportJSON'], ['csv', 'exportCSV'], ['html', 'exportHTML'], ['stix', 'exportSTIX']]) { const control = button(tr(key), () => exportHistory(format)); control.dataset.ciExport = format; exports.appendChild(control); } exportSection.append(exports, paragraph(tr('exportPrintHelp'))); body.appendChild(exportSection);
    historyNodes = { status: element('div', 'ci-history-status'), summary: element('section', 'ci-section ci-timeline'), list: element('div', 'ci-history-results'), pagination: element('nav', 'ci-pagination') }; historyNodes.status.setAttribute('aria-live', 'polite'); historyNodes.pagination.setAttribute('aria-label', tr('history'));
    body.append(historyNodes.status, historyNodes.summary, historyNodes.list, historyNodes.pagination); fetchHistory(); return true;
  }
  async function fetchHistory() {
    if (mode !== 'history') return;
    if (replaying()) { stopHistory(); historyNodes.status?.replaceChildren(status(replayNote())); return; }
    clearTimeout(historyTimer); historyTimer = null;
    const version = ++historyVersion; historyController?.abort(); historyController = new AbortController(); historyResult = null;
    historyNodes.status.replaceChildren(status(tr('historyLoading'))); historyNodes.list.replaceChildren(); historyNodes.summary.replaceChildren(); historyNodes.pagination.replaceChildren();
    try {
      if (window.navigator?.onLine === false) throw new Error('offline');
      const response = await window.fetch('/api/history?' + queryString(), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: historyController.signal });
      if (!response.ok) throw new Error('history response'); const data = await response.json();
      if (version !== historyVersion || mode !== 'history') return;
      if (!data || !Array.isArray(data.items) || !Number.isFinite(data.total) || data.total < 0) throw new Error('invalid history');
      historyResult = { ...data, items: data.items.slice(0, filters.limit), total: Math.floor(data.total), offset: filters.offset, limit: filters.limit }; renderHistory();
    } catch {
      if (version !== historyVersion || mode !== 'history') return;
      const message = window.navigator?.onLine === false ? tr('offline') : tr('historyError'); historyNodes.status.replaceChildren(status(message, true), button(tr('retry'), fetchHistory));
    }
  }
  function eventCard(record) {
    const card = element('article', 'ci-event-card'), id = bounded(record?.id, 128), title = bounded(record?.title, 500) || tr('details');
    const open = button(title, () => openEvent(record), 'ci-result-title'); open.dataset.ciEventId = id; card.appendChild(open);
    card.append(paragraph([bounded(record?.source?.name, 160), label('kind', record?.kind), time(record?.lastSeenAt || record?.collectedAt)].filter(Boolean).join(' · '), 'ci-event-meta'));
    if (record?.summary) card.appendChild(paragraph(bounded(record.summary, 500), 'ci-result-summary')); return card;
  }
  function renderHistory() {
    const { items, total, offset, limit, stats } = historyResult; historyNodes.status.replaceChildren(status(tr('results', { count: total })));
    if (!items.length) historyNodes.list.appendChild(paragraph(tr('historyEmpty'), 'ci-empty')); for (const item of items) historyNodes.list.appendChild(eventCard(item));
    const countByDay = new Map(); for (const item of items) { const timestamp = item?.lastSeenAt || item?.collectedAt, day = validTime(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : tr('unknownTime'); countByDay.set(day, (countByDay.get(day) || 0) + 1); }
    const provided = Array.isArray(stats?.days), days = provided ? stats.days.filter(day => typeof day?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(day.count) && day.count >= 0).slice(-60) : [...countByDay].map(([date, count]) => ({ date, count }));
    historyNodes.summary.append(element('h3', '', tr('summary')), paragraph(tr(provided ? 'summaryScope' : 'summaryPage')));
    if (validTime(stats?.earliestAt) || validTime(stats?.latestAt)) historyNodes.summary.appendChild(paragraph(time(stats.earliestAt) + ' → ' + time(stats.latestAt), 'ci-event-meta'));
    const list = element('ol', 'ci-day-list'); for (const day of days) { const row = element('li'); row.append(element('time', '', bounded(day.date, 30)), element('strong', '', String(Math.floor(day.count)))); list.appendChild(row); } historyNodes.summary.appendChild(list);
    const pages = Math.max(1, Math.ceil(total / limit)), page = Math.floor(offset / limit) + 1;
    const previous = button(tr('previous'), () => { filters.offset = Math.max(0, offset - limit); fetchHistory(); }); previous.dataset.ciPage = 'previous'; previous.disabled = offset === 0;
    const next = button(tr('next'), () => { filters.offset = offset + limit; fetchHistory(); }); next.dataset.ciPage = 'next'; next.disabled = offset + limit >= total;
    historyNodes.pagination.append(previous, element('span', '', tr('page', { page, pages })), next);
  }
  function exportHistory(format) {
    if (!options.historyEnabled || !['json', 'csv', 'html', 'stix'].includes(format)) return;
    if (replaying()) { historyNodes.status?.replaceChildren(status(replayNote())); return; }
    const query = queryString(false); query.set('format', format); const url = '/api/export?' + query;
    if (format === 'html') {
      const report = window.open(url, '_blank');
      if (!report) { historyNodes.status.replaceChildren(status(tr('exportBlocked'), true)); return; }
      try { report.opener = null; report.addEventListener?.('load', () => { try { report.print(); } catch { /* Manual Print remains available. */ } }, { once: true }); } catch { /* The report itself exposes a print action. */ }
      return;
    }
    const link = element('a'); link.href = url; link.download = 'crucix-events.' + (format === 'stix' ? 'json' : format); link.hidden = true; document.body.appendChild(link); link.click(); link.remove();
  }
  function normalizeLayout(raw) {
    const seen = new Set(), zones = {};
    for (const zone of ZONES) { zones[zone] = []; const ids = Array.isArray(raw?.zones?.[zone]) ? raw.zones[zone].slice(0, PANELS.length) : []; for (const id of ids) if (PANELS.includes(id) && !seen.has(id)) { zones[zone].push(id); seen.add(id); } }
    for (const zone of ZONES) for (const id of DEFAULT_ZONES[zone]) if (!seen.has(id)) { if (TOP_PANELS.includes(id) && typeof raw?.visibility?.[id] !== 'boolean') { let at = 0; while (at < zones[zone].length && TOP_PANELS.includes(zones[zone][at])) at++; zones[zone].splice(at, 0, id); } else zones[zone].push(id); seen.add(id); }
    const visibility = {}; for (const id of PANELS) visibility[id] = typeof raw?.visibility?.[id] === 'boolean' ? raw.visibility[id] : true;
    const fixed = {}; for (const id of ['map', 'mapRegions']) fixed[id] = typeof raw?.fixed?.[id] === 'boolean' ? raw.fixed[id] : true; return { zones, visibility, fixed };
  }
  function normalizeState(raw) {
    const layers = {}; for (const id of LAYERS) layers[id] = typeof raw?.layers?.[id] === 'boolean' ? raw.layers[id] : !LAYERS_OFF.includes(id);
    return { layout: normalizeLayout(raw?.layout), layers, region: REGIONS.includes(raw?.region) ? raw.region : 'world' };
  }
  function currentState() { return normalizeState({ layout: options.getLayout?.(), layers: options.getLayers?.(), region: options.getRegion?.() }); }
  function readProfiles() {
    profiles = []; customState = null; storageUnavailable = false;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY); if (!raw || raw.length > MAX_STORAGE) return; const parsed = JSON.parse(raw); if (parsed?.version !== 1) return;
      const ids = new Set(); for (const entry of Array.isArray(parsed.profiles) ? parsed.profiles.slice(0, 100) : []) {
        const id = bounded(entry?.id, 80), name = bounded(entry?.name, 64).trim();
        if (!/^user-[a-z0-9-]{1,64}$/.test(id) || !name || ids.has(id)) continue;
        profiles.push({ id, name, ...normalizeState(entry) }); ids.add(id); if (profiles.length === MAX_PROFILES) break;
      }
      if (parsed.customState && typeof parsed.customState === 'object') customState = normalizeState(parsed.customState);
    } catch { storageUnavailable = true; }
  }
  function persistProfiles() { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, profiles, customState })); } catch { storageUnavailable = true; } }
  function preset(id) {
    const state = normalizeState({});
    const selectedPanels = id === 'market' ? ['macroMarkets', 'tradeIdeas', 'newsTicker', 'changes', 'countryRisk', 'crossSourceSignals', 'sensorGrid', 'riskGauges', 'sourceHealth', 'sweepDelta', 'liveSources'] : id === 'infrastructure' ? ['sensorGrid', 'nuclearWatch', 'internetOutages', 'healthAlerts', 'supplementalHealth', 'sourceHealth', 'changes', 'countryRisk', 'crossSourceSignals', 'newsTicker', 'sweepDelta', 'liveSources'] : PANELS.filter(panel => !['macroMarkets', 'tradeIdeas'].includes(panel));
    const selectedLayers = id === 'market' ? ['air', 'maritime', 'news', 'weather', 'thermal'] : id === 'infrastructure' ? ['air', 'thermal', 'sdr', 'maritime', 'nuclear', 'health', 'network', 'weather', 'earthquake'] : ['conflict', 'osint', 'news', 'health', 'network', 'earthquake'];
    for (const panel of PANELS) state.layout.visibility[panel] = selectedPanels.includes(panel);
    for (const layer of LAYERS) state.layers[layer] = selectedLayers.includes(layer);
    if (id === 'infrastructure') { state.layout.zones.center1 = ['internetOutages', 'newsTicker']; state.layout.zones.center2 = ['healthAlerts', 'supplementalHealth', 'macroMarkets']; state.layout.zones.center3 = ['sourceHealth', 'tradeIdeas']; state.layout.zones.right = state.layout.zones.right.filter(panel => !['internetOutages', 'healthAlerts', 'supplementalHealth', 'sourceHealth'].includes(panel)); }
    return normalizeState(state);
  }
  function applyProfile(id) {
    const own = profiles.find(profile => profile.id === id), state = id === 'custom' ? customState : ['research', 'market', 'infrastructure'].includes(id) ? preset(id) : own;
    if (!state) return;
    try {
      const current = currentState(), target = normalizeState(state);
      if (id !== 'custom' && (!lastAppliedState || JSON.stringify(current) !== JSON.stringify(lastAppliedState))) { customState = current; persistProfiles(); }
      options.applyLayout?.(target.layout); options.applyLayers?.(target.layers); options.applyRegion?.(target.region); lastAppliedState = target; profileMessage = tr('profileApplied');
    } catch { profileMessage = tr('profileError'); }
    renderProfiles();
  }
  function saveProfile() {
    const name = bounded(document.getElementById('ci-profile-name')?.value, 64).trim();
    if (!name) { profileMessage = tr('profileNameRequired'); renderProfiles(name); document.getElementById('ci-profile-name').focus(); return; }
    const own = profiles.find(profile => profile.id === editingId);
    if (editingId && own) { own.name = name; profileMessage = tr('profileRenamed'); editingId = null; }
    else {
      if (profiles.length >= MAX_PROFILES) { profileMessage = tr('profileLimit'); renderProfiles(name); return; }
      try { let id; do { id = 'user-' + Date.now().toString(36) + '-' + (++profileSerial).toString(36); } while (profiles.some(profile => profile.id === id)); profiles.push({ id, name, ...currentState() }); profileMessage = tr('profileSaved'); } catch { profileMessage = tr('profileError'); renderProfiles(name); return; }
    }
    persistProfiles(); renderProfiles();
  }
  function profileAction(text, action, id, handler) { const node = button(text, handler); node.dataset.ciProfileAction = action; if (id) node.dataset.profileId = id; return node; }
  function profileCard(id, name, copy, own) {
    const card = element('article', 'ci-profile-card'); card.append(element('h3', '', name)); if (copy) card.appendChild(paragraph(copy));
    const actions = element('div', 'ci-actions'); actions.appendChild(profileAction(tr('apply'), 'apply', id, () => applyProfile(id)));
    if (own) {
      actions.appendChild(profileAction(tr('rename'), 'rename', id, () => { const profile = profiles.find(item => item.id === id); if (!profile) return; editingId = id; profileMessage = ''; renderProfiles(profile.name); document.getElementById('ci-profile-name').focus(); }));
      actions.appendChild(profileAction(tr('delete'), 'delete', id, () => { if (!profiles.some(profile => profile.id === id)) return; profiles = profiles.filter(profile => profile.id !== id); if (editingId === id) editingId = null; profileMessage = tr('profileDeleted'); persistProfiles(); renderProfiles(); }));
    }
    card.appendChild(actions); return card;
  }
  function renderProfiles(name = '') {
    const focused = document.activeElement?.dataset, focusAction = focused?.ciProfileAction, focusId = focused?.profileId;
    const body = show('profiles', tr('profiles')); body.appendChild(paragraph(tr('profilesHelp')));
    if (storageUnavailable) body.appendChild(status(tr('sessionStorage')));
    const presets = element('div', 'ci-profile-grid'); for (const id of ['research', 'market', 'infrastructure']) presets.appendChild(profileCard(id, tr(id), tr(id + 'Copy'), false));
    if (customState) presets.appendChild(profileCard('custom', tr('custom'), tr('customCopy'), false)); body.appendChild(presets);
    const save = element('form', 'ci-profile-form'); save.addEventListener('submit', event => { event.preventDefault(); saveProfile(); });
    const input = element('input', 'ci-input'); input.id = 'ci-profile-name'; input.type = 'text'; input.maxLength = 64; input.value = name; field(save, 'profileName', input);
    save.appendChild(profileAction(tr(editingId ? 'renameProfile' : 'saveProfile'), 'save', null, saveProfile));
    if (editingId) save.appendChild(button(tr('cancel'), () => { editingId = null; profileMessage = ''; renderProfiles(); }));
    body.append(save, paragraph(tr('profileCount', { count: profiles.length })));
    if (profileMessage) body.appendChild(status(profileMessage, ['profileError', 'profileLimit', 'profileNameRequired'].some(key => tr(key) === profileMessage)));
    const saved = element('section', 'ci-section'); saved.appendChild(element('h3', '', tr('savedProfiles')));
    if (!profiles.length) saved.appendChild(paragraph(tr('noProfiles'))); else { const grid = element('div', 'ci-profile-grid'); for (const profile of profiles) grid.appendChild(profileCard(profile.id, profile.name, '', true)); saved.appendChild(grid); } body.appendChild(saved);
    if (focusAction) { const node = [...dialog.querySelectorAll('[data-ci-profile-action]')].find(item => item.dataset.ciProfileAction === focusAction && item.dataset.profileId === focusId); (node || document.getElementById('ci-profile-name')).focus({ preventScroll: true }); }
  }
  function openProfiles() { if (!options.profilesEnabled) return false; detailVersion++; detailController?.abort(); returnToHistory = false; editingId = null; profileMessage = ''; renderProfiles(); return true; }
  function openCluster(cluster) {
    const ids = new Set(Array.isArray(cluster?.eventIds) ? cluster.eventIds.slice(0, 200) : []), events = allEvents().filter(item => ids.has(item?.id));
    returnToHistory = false; detailVersion++; detailController?.abort(); detailId = null;
    const body = show('cluster', tr('cluster')); body.appendChild(paragraph(tr('clusterHelp'))); if (!events.length) body.appendChild(paragraph(tr('noEvents'))); for (const record of events) body.appendChild(eventCard(record)); return !!events.length;
  }
  function openEvents() {
    const all = allEvents(), events = all.slice(0, 200); returnToHistory = false; detailVersion++; detailController?.abort(); detailId = null;
    const body = show('events', tr('events')); body.appendChild(paragraph(tr('listCount', { shown: events.length, total: all.length })));
    if (!events.length) body.appendChild(paragraph(tr('noEvents'))); for (const record of events) body.appendChild(eventCard(record)); return true;
  }
  function init(settings = {}) { if (overlay) close(); options = settings && typeof settings === 'object' ? settings : {}; snapshot = options.getSnapshot?.() || { events: [] }; pushedSnapshot = false; lastAppliedState = null; if (options.profilesEnabled) readProfiles(); return window.CrucixIntelligence; }
  function update(data) { if (data && typeof data === 'object') { snapshot = data; pushedSnapshot = true; } /* Dialogs retain the user's reading/filter/focus state during SSE sweeps. */ }
  window.CrucixIntelligence = Object.freeze({ init, update, openEvent, openHistory, openProfiles, openCluster, openEvents });
})(window, document);
