import { POLICIES, freshResult, providerTime } from '../../apis/utils/freshness.mjs';
export const LIVE_KINDS = ['weather','disaster','space-weather','economic','forecast','network','cyber','earthquake','maritime','aviation','sanctions','market','energy','interference','displacement','launch','health'];
const text = (value, cap=300) => typeof value==='string' ? value.slice(0,cap).replace(/[\u0000-\u001f\u007f]/g,' ').trim() : '';
export const HOME = { Maritime:"https://aisstream.io/", Meteoalarm:'https://meteoalarm.org/', GDACS:'https://www.gdacs.org/', 'NOAA-SWPC':'https://www.swpc.noaa.gov/', ECB:'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html', 'NASA-EONET':'https://eonet.gsfc.nasa.gov/', RIPEstat:'https://stat.ripe.net/', 'FIRST-EPSS':'https://www.first.org/epss/', 'MET-Norway':'https://api.met.no/', OONI:'https://explorer.ooni.org/', 'IMF-PortWatch':'https://portwatch.imf.org/', EMSC:'https://www.seismicportal.eu/', 'Copernicus-EMS':'https://mapping.emergency.copernicus.eu/', 'Aviation-SIGMET':'https://aviationweather.gov/', 'ADSB-Military':'https://adsb.lol/', 'OpenSanctions-Index':'https://www.opensanctions.org/', 'Federal-Register':'https://www.federalregister.gov/', 'Energy-Charts-HU':'https://energy-charts.info/', 'ENTSOG-HU':'https://transparency.entsog.eu/', 'Prediction-Markets':'https://manifold.markets/', ThreatFox:'https://threatfox.abuse.ch/', HIBP:'https://haveibeenpwned.com/', GPSJam:'https://gpsjam.org/', 'WMO-SWIC':'https://severeweather.wmo.int/', 'UNHCR-Arrivals':'https://data.unhcr.org/en/situations/europe-sea-arrivals', 'SEC-8K':'https://www.sec.gov/edgar/search/', 'Open-Meteo-Wind':'https://open-meteo.com/', 'ADSB-Orbits':'https://adsb.lol/', 'NOAA-NHC':'https://www.nhc.noaa.gov/', 'JMA-Typhoon':'https://www.jma.go.jp/bosai/map.html#contents=typhoon', 'ECDC-Threats':'https://www.ecdc.europa.eu/en/news-events', 'Central-Banks':'https://data.bis.org/topics/CBPOL', 'CFTC-COT':'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm', 'FAA-Airports':'https://nasstatus.faa.gov/', Regulators:'https://www.federalreserve.gov/newsevents/pressreleases.htm', 'Eurostat-HU':'https://ec.europa.eu/eurostat/web/main/home', 'Launch-Library':'https://thespacedevs.com/llapi' };
export const FACT_FIELDS = { Maritime:["vessels","moving","tankers"], 'FIRST-EPSS':['epss','percentile','predictionWindowDays'], GDACS:['eventType'], 'NASA-EONET':['category'], Meteoalarm:['area'], ECB:['currency','rate','baseCurrency','rateType'], RIPEstat:['resource','observedNeighbours'], 'MET-Norway':['temperature','windSpeed','precipitation','precipitationHours','symbol'], OONI:['countryCode','measurementStatus','targetHost','resource','blockingConfirmed'], 'NOAA-SWPC':[], 'IMF-PortWatch':['transitCalls','mean7d','baseline28d','changePct'], EMSC:['magnitude','depthKm'], 'Copernicus-EMS':['category','countries'], 'Aviation-SIGMET':['hazard','fir'], 'ADSB-Military':['aircraft','types'], 'OpenSanctions-Index':['thingCount','deltaSinceLast'], 'Federal-Register':['docType','agency'], 'Energy-Charts-HU':['pricePerMwh','frequencyHz','renewableSharePct'], 'ENTSOG-HU':['physicalFlow','unit'], 'Prediction-Markets':['probabilityPct','volume','closesAt','platform'], ThreatFox:['family','iocCount','c2Count'], HIBP:['domain','pwnCount','breachDate'], GPSJam:['highCells','mediumCells','worstPct','badAircraft','totalAircraft','sharePct'], 'WMO-SWIC':[], 'UNHCR-Arrivals':['yearToDate','lastMonth','usualMonth'], 'SEC-8K':['company','ticker','formType','cik'], 'Open-Meteo-Wind':['windMs','windFromDeg','windToward','windGustMs'], 'ADSB-Orbits':['aircraft','types','operators'], 'NOAA-NHC':['stormClass','windKt','pressureMb','movement'], 'JMA-Typhoon':['stormClass','windKt','pressureMb','movement'], 'ECDC-Threats':['alertLevel'], 'Central-Banks':['policyRate','changePp','stressIndex'], 'CFTC-COT':['netPosition','netShare','rank52w'], 'FAA-Airports':['delayKind','avgDelayMin','reason'], Regulators:['agency'], 'Eurostat-HU':['hungaryValue','euValue','period'], 'Launch-Library':['rocket','missionType','orbit','provider','pad','launchStatus'] };
function safeUrl(raw) {
  if (typeof raw!=='string' || raw.length>2048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  try { const url = new URL(raw);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key=>/^(?:access[-_]?token|refresh[-_]?token|api[-_]?key|token|secret|password|authorization|auth|signature)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}
function metrics(raw, depth=0, budget={remaining:50}) {
  if (depth>3 || !raw || typeof raw!=='object') return {};
  const out = {};
  for (const [key,value] of Object.entries(raw).slice(0,40)) {
    if (budget.remaining--<=0) break;
    if (['__proto__','constructor','prototype'].includes(key)) continue;
    const name=text(key,80);
    if (typeof value==='string') out[name]=text(value,200);
    else if (typeof value==='number' && Number.isFinite(value) || typeof value==='boolean') out[name]=value;
    else if (value && typeof value==='object' && !Array.isArray(value)) out[name]=metrics(value,depth+1,budget);
  }
  return out;
}
const FACT_UNITS = ['temperature','windSpeed','precipitation'];
function fact(label, value) {
  const name=text(label,40), shown=typeof value==='string' ? text(value,120) : value;
  if (!name || shown==='' || !(typeof shown==='string' || typeof shown==='boolean' || typeof shown==='number' && Number.isFinite(shown))) return null;
  return { label:name, value:shown };
}
// Whitelisted fields only; a row that already carries facts (re-normalization) keeps them, sanitised again.
function factsOf(row, source) {
  const pairs=Array.isArray(row?.facts) ? row.facts.slice(0,40).map(entry=>[entry?.label,entry?.value]) : (FACT_FIELDS[source]||[]).map(key=>{
    const value=row?.[key], unit=source==='MET-Norway' && FACT_UNITS.includes(key) ? row?.units?.[key] : undefined;
    return [key, typeof value==='number' && Number.isFinite(value) && typeof unit==='string' && unit.length<=20 && text(unit,20) ? `${value} ${text(unit,20)}` : value];
  });
  return pairs.map(([label,value])=>fact(label,value)).filter(Boolean).slice(0,8);
}
export function normalizeLiveSources(input, now=Date.now()) {
  const result=[], sources=Object.keys(POLICIES);
  for (const source of sources) {
    const raw=Array.isArray(input) ? input.slice(0,sources.length).find(row=>row?.source===source) : input?.[source];
    // A reference-only result (Maritime without its live AIS collector) has no provider time and is not a live source.
    if (!raw || typeof raw!=='object' || raw.status==='reference') continue;
    const rows=Array.isArray(raw.observations)?raw.observations.slice(0,100).map(row=>{
      const item={source,sourceStatus:'ok',kind:LIVE_KINDS.includes(row?.kind)?row.kind:'signal',url:safeUrl(row?.url),title:text(row?.title),summary:text(row?.summary,2000)};
      for (const key of ['providerId','id','country','region','place','locationMethod','locationPrecision','severity']) if (text(row?.[key],200)) item[key]=text(row[key],200);
      if (typeof row?.eventId==='string' && /^event-[0-9a-f]{32}$/.test(row.eventId)) item.eventId=row.eventId;
      for (const key of ['observedAt','publishedAt','forecastAt','startsAt','validUntil']) if (row?.[key]!==undefined) item[key]=providerTime(row[key]);
      if (Number.isFinite(row?.lat)&&Math.abs(row.lat)<=90&&Number.isFinite(row?.lon)&&Math.abs(row.lon)<=180) { item.lat=row.lat;item.lon=row.lon; }
      const facts=factsOf(row,source); if (facts.length) item.facts=facts;
      if (raw.timestamp) item.collectedAt=providerTime(raw.timestamp);
      return item;
    }).filter(row=>row.title):[];
    const out=freshResult(source,raw.observedAt,rows,{},now);
    out.timestamp=providerTime(raw.timestamp);
    out.url=HOME[source]; out.attribution=text(raw.attribution,600);out.rights=text(raw.rights,1000);
    out.license=text(raw.license,200);out.licenseUrl=safeUrl(raw.licenseUrl);
    if (raw.status==='error' || raw.error) {out.status='error';out.stale=false;out.observations=[];out.error=text(raw.error||'Source unavailable');}
    else if (raw.status==='stale' || raw.stale) {out.status='stale';out.stale=true;out.observations=[];}
    out.summary=out.status==='ok'?text(raw.summary,2000):'';
    out.metrics=out.status==='ok'?metrics(raw.metrics):{};
    if (source==='MET-Norway' && out.observations.length!==(Array.isArray(raw.observations)?raw.observations.length:0)) { out.summary='';out.metrics={}; }
    result.push(out);
  }
  return result;
}

// Called on read as well as synthesis: a paused server cannot revive an old feed.
export function freshLiveSnapshot(snapshot, now=Date.now()) {
  if (!snapshot || !Array.isArray(snapshot.liveSources)) return snapshot;
  const liveSources=normalizeLiveSources(snapshot.liveSources,now);
  const states=new Map(liveSources.map(row=>[row.source,row]));
  return { ...snapshot,liveSources,
    aisVessels: states.get("Maritime")?.status === "ok" && Array.isArray(snapshot.aisVessels) ? snapshot.aisVessels.filter(v => { const stamp=providerTime(v?.lastSeen); const at=stamp?Date.parse(stamp):NaN; return Number.isFinite(at) && now-at >= -300000 && now-at <= POLICIES.Maritime.observationMaxAgeMs; }) : [],
    events:Array.isArray(snapshot.events)?snapshot.events.filter(event=>!Object.hasOwn(POLICIES,event?.source?.name)||states.get(event.source.name)?.status==='ok'&&states.get(event.source.name).observations.some(row=>row.title===event.title && row.observedAt===event.observedAt)):[],
    health:Array.isArray(snapshot.health)?snapshot.health.map(row=>states.has(row.n)?{...row,stale:states.get(row.n).status==='stale',err:states.get(row.n).status==='error',observedAt:states.get(row.n).observedAt,freshness:states.get(row.n).freshness}:row):[],
  };
}
