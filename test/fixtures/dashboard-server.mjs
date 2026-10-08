// Deterministic local UI fixture; never loads operator .env or runtime runs.
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { inlineJson } from '../../lib/html.mjs';
import { buildEvents, clusterEvents, stampLiveEventIds } from '../../lib/intelligence/events.mjs';
import { HistoryStore } from '../../lib/intelligence/history.mjs';
import { installIntelligenceRoutes } from '../../lib/intelligence/routes.mjs';
import { getLocaleForLanguage } from '../../lib/i18n.mjs';
import { renderOfflineShell } from '../../lib/offline-shell.mjs';
import { POLICIES } from '../../apis/utils/freshness.mjs';
import { normalizeLiveSources, FACT_FIELDS } from '../../lib/intelligence/live-sources.mjs';
import { AlertEngine } from '../../lib/alerts/engine.mjs';
import { installAlertRoutes } from '../../lib/alerts/routes.mjs';
import { writeJsonAtomic } from '../../lib/atomic-json.mjs';
import { SweepArchive } from '../../lib/sweeps/archive.mjs';
import { installSweepRoutes } from '../../lib/sweeps/routes.mjs';
import { installApiErrorHandler } from '../../lib/api-errors.mjs';
import { archiveSweep } from '../../lib/sweeps/step.mjs';
import { buildChanges } from '../../lib/sweeps/changes.mjs';
import { domainOfSource } from '../../lib/domains.mjs';
import { EntityStore } from '../../lib/intelligence/entities.mjs';
import { PredictionJournal } from '../../lib/intelligence/predictions.mjs';
import { runRiskStep } from '../../lib/intelligence/risk-step.mjs';
import { installRiskRoutes } from '../../lib/intelligence/risk-routes.mjs';
import { createBriefingService } from '../../lib/llm/briefing.mjs';
const template = readFileSync(new URL('../../dashboard/public/jarvis.html', import.meta.url), 'utf8');
const embedded = template.match(/^(?:let|const) D = (.*);\s*$/m);
const data = JSON.parse(embedded[1]);
data.meta = { ...data.meta, timestamp: new Date().toISOString(), sourcesQueried: 31, sourcesOk: 28, sourcesFailed: 1, sourcesDisabled: 1, sourcesStale: 1 };
data.health = [{ n: 'Fixture live', err: false, timestamp: data.meta.timestamp },
  { n: 'Fixture error', err: true, message: 'HTTP 503', timestamp: data.meta.timestamp },
  { n: 'Fixture stale', stale: true, timestamp: new Date(Date.now() - 3600000).toISOString() },
  { n: 'Fixture disabled', disabled: true }];
data.newsFeed.unshift({ headline: '<img src=x onerror="window.__injected=1"', source: 'Fixture', timestamp: data.meta.timestamp, type: 'rss' });
data.newsFeed.unshift({ headline: 'Fixture complete headline <img src=x onerror="window.__injected=3">', source: 'Fixture complete', timestamp: data.meta.timestamp, type: 'rss' });
data.newsFeed.unshift({ headline: 'Fixture waiting for SSE', source: 'Fixture SSE', timestamp: data.meta.timestamp, type: 'rss' });
data.news.unshift({ title: 'Fixture popup <img src=x onerror="window.__injected=4">', source: 'Fixture popup', lat: 40, lon: -30, region: 'Fixture' });
data.earthquakes = [{ id: 'fixture-quake', magnitude: 6.2, place: 'Test earthquake', time: data.meta.timestamp, lat: 36, lon: 140, depth: 25, tsunamiFlag: 0, url: 'https://earthquake.usgs.gov/' }];
data.ideas = [{ type: 'HEDGE', title: 'Fixture idea', rationale: 'Safe text <img src=x onerror="window.__injected=2">', ticker: 'TEST', confidence: 'HIGH', horizon: 'Days', risk: 'Fixture' }];
data.ideasSource = 'rules';
const reports = [1,2].map(n=>({title:'Fixture Hungary flood response '+n,headline:'Fixture Hungary flood response '+n,source:'Fixture Report '+n,date:data.meta.timestamp,publishedAt:data.meta.timestamp,url:`https://fixture${n}.example/report`,lat:47.5,lon:19.1,locationMethod:'headline-keyword',locationPrecision:'approximate'}));
data.news.push(...reports);data.newsFeed.push(...reports);
// Sweep archive (structure QA): sources of four domains next to the domain-less "Fixture" rows, and a hostile source name and record
// title that reach the source-health panel, the matrix, the changes panel and the palette's record search.
const HOSTILE='<img src=x onerror="window.__structureXss=1">';
data.health.push(...['GDELT','NOAA','FRED','WHO',HOSTILE].map(n=>({n,err:false,timestamp:data.meta.timestamp})));
data.newsFeed.push({headline:'Fixture structure record '+HOSTILE,source:'Fixture structure',timestamp:data.meta.timestamp,type:'rss'});
data.events = buildEvents(data);
data.eventClusters = clusterEvents(data.events);
const historyDir = mkdtempSync(join(tmpdir(),'crucix-fixture-'));
const history = new HistoryStore(historyDir);history.add(data.events);
const api=express();installIntelligenceRoutes(api,{getSnapshot:()=>data,history,language:'en'});
// Country risk (2.13): the real store, journal, step, routes and rule-based briefing (no model) over the fixture's tmp dir, with small fixed
// VIEWS/INFORM inputs so the panel has a ranking with forecast and baseline components. Every rebuild of the events runs the step again.
const riskStore=new EntityStore(historyDir),riskJournal=new PredictionJournal(historyDir);let riskLatest=null;
const VIEWS_MONTH=(new Date().getUTCFullYear()-1980)*12+new Date().getUTCMonth()+1;
const viewsRows=(name,p)=>({months:[0,1,2].map(i=>({isoab:name,name,month_id:VIEWS_MONTH+i,year:new Date().getUTCFullYear(),month:((new Date().getUTCMonth()+i)%12)+1,main_dich:Math.max(0,p-i*0.02),main_mean:p*120}))});
const riskRaw={sources:{'VIEWS-Forecast':{status:'ok',run:'fatalities003_fixture_t01',months:[VIEWS_MONTH,VIEWS_MONTH+1,VIEWS_MONTH+2],attribution:'Conflict forecasts: VIEWS (Uppsala University and PRIO), fixture run.',license:'Fixture licence text',
  countries:{SDN:viewsRows('SDN',0.97),UKR:viewsRows('UKR',0.95),COD:viewsRows('COD',0.9),SOM:viewsRows('SOM',0.88),SYR:viewsRows('SYR',0.8),MMR:viewsRows('MMR',0.78),JPN:viewsRows('JPN',0.01)}},
  'INFORM-Risk':{status:'ok',release:'INFORM Risk Fixture 2026',published:'2026-09-02',attribution:'INFORM Risk Index, European Commission Joint Research Centre (fixture).',license:'INFORM is open-source',
    countries:{SDN:{score:7.4},UKR:{score:5.1},COD:{score:7.6},SOM:{score:8.6},SYR:{score:7.1},MMR:{score:6.5},JPN:{score:2.1},HUN:{score:1.9}}}}};
function recordRisk(){const result=runRiskStep({store:riskStore,journal:riskJournal,snapshot:data,raw:riskRaw,log:quietRisk});if(result.ok)riskLatest=result;}
const quietRisk={warn(){},error(){},log(){}};
recordRisk();
installRiskRoutes(api,{store:riskStore,journal:riskJournal,getSnapshot:()=>data,getState:()=>riskLatest,history,
  briefing:createBriefingService({provider:null,language:'en',store:riskStore,history,getSnapshot:()=>data,getScores:()=>riskLatest?.scores??null,log:quietRisk}),security:{}});
process.on('exit',()=>rmSync(historyDir,{recursive:true,force:true}));
let online = true;
let fixtureLanguage = 'en';
const streams = new Set();
// Alerts: the real engine and API over the fixture's tmp dir; /control?alerts=seed|newcritical|clear writes a fixed set.
const alertEngine=new AlertEngine(historyDir,{logger:{warn(){},error(){},log(){}}});alertEngine.load();data.alerts=alertEngine.summary();
const publishAlerts=(summary,newIds)=>{data.alerts=summary;for(const client of streams)client.write(`data: ${JSON.stringify({type:'alerts',data:summary,newIds})}\n\n`);};
installAlertRoutes(api,{engine:alertEngine,getSnapshot:()=>data,onChange:publishAlerts});
let fixtureAlerts=0;
function fixtureAlert(ruleId,ruleName,kind,severity,state,title,extra={}){
  const n=++fixtureAlerts,at=Date.now()-60000*(10-Math.min(n,9));
  return {id:'alert-'+String(n).padStart(32,'0'),ruleId,ruleName,dedupKey:`${ruleId}|fixture-${n}`,kind,severity,state,title,summary:'Fixture alert summary '+n,
    entity:{type:kind,id:'fixture-'+n},evidence:[],firstSeenAt:at,lastSeenAt:at,count:1,notify:true,silent:false,log:[{at,action:'created'}],...extra};
}
function seedAlerts(mode){
  let alerts=[];
  if(mode==='seed'){
    fixtureAlerts=0;
    const evidence=data.events.slice(0,2).map(event=>({type:'event',id:event.id,title:event.title,source:event.source?.name||'',level:'high'}));
    alerts=[fixtureAlert('events-critical','Critical events','event','critical','firing','Fixture critical alert'),
      fixtureAlert('events-high','High-severity events','event','high','firing','Fixture high alert',{evidence}),
      fixtureAlert('hungary-region','Hungary region','event','watch','firing','Fixture watch alert <img src=x onerror="window.__alertXss=1">'),
      fixtureAlert('vix-spike','VIX spike','threshold','high','acked','Fixture acknowledged alert',{ack:{at:Date.now()-30000}})];
  } else if(mode==='newcritical') {
    alerts=[...alertEngine.list({state:'all',limit:1000}),fixtureAlert('events-critical','Critical events','event','critical','firing','Fixture new critical alert',{firstSeenAt:Date.now(),lastSeenAt:Date.now()})];
  } else fixtureAlerts=0;
  writeJsonAtomic(join(historyDir,'alerts','alerts.json'),{version:1,alerts,engine:{initialized:true,lastEvaluatedAt:Date.now()}});
  alertEngine.load();
  publishAlerts(alertEngine.summary(),mode==='newcritical'?[alerts.at(-1).id]:[]);
}
// /control?liveSources=true: one current sample per POLICIES key, so a new source appears without a fixture edit. SAMPLE adds what a source
// needs beyond the default (a 'disaster' row without coordinates): its kind, a place for located kinds (`at`, or `indexed`: 47.5+i, 19+i),
// row extras, metrics; every FACT_FIELDS key gets a value. Located rows show the map marker of each kind.
const SAMPLE={
  Meteoalarm:{rows:false},'NOAA-SWPC':{rows:false,summary:'Current NOAA R0/S0/G0: no active space-weather alert.'},
  GDACS:{indexed:true,row:{severity:'Orange'}},'NASA-EONET':{indexed:true},ECB:{kind:'economic'},RIPEstat:{kind:'network'},'FIRST-EPSS':{kind:'cyber'},OONI:{kind:'network'},
  'MET-Norway':{kind:'forecast',indexed:true,row:now=>({forecastAt:new Date(now+3600000).toISOString(),validUntil:new Date(now+7200000).toISOString()})},
  'IMF-PortWatch':{kind:'maritime',at:[26.2969,56.8598],metrics:{hormuz_transits:3.1,suez_transits:40}},
  EMSC:{kind:'earthquake',at:[51.8043,159.605],precision:'exact',row:{severity:'moderate'}},
  'Copernicus-EMS':{at:[37.7895,-7.2135],row:{severity:'moderate'}},
  'Aviation-SIGMET':{kind:'weather',at:[39.2,45.417],method:'polygon-centroid',row:{severity:'high'}},
  'ADSB-Military':{kind:'aviation',at:[25,48],method:'theater-centre',metrics:{mil_aircraft_total:71}},
  'UNHCR-Arrivals':{kind:'displacement',at:[41.9,12.5],method:'country-centroid',row:{severity:'moderate'}},GPSJam:{kind:'interference',at:[56.1,23.4],method:'centroid',row:{severity:'moderate'}},'WMO-SWIC':{kind:'weather',at:[35.9,104.2],method:'member-point',row:{severity:'high'}},
  'OpenSanctions-Index':{kind:'sanctions'},'Federal-Register':{kind:'sanctions'},
  'Energy-Charts-HU':{kind:'energy',metrics:{hu_power_price:172.6,grid_frequency_hz:50.0307}},'ENTSOG-HU':{kind:'energy'},'Prediction-Markets':{kind:'market'},
};
function liveSamples(now){
  const quake=data.earthquakes[0];
  return Object.fromEntries(Object.keys(POLICIES).map((source,index)=>{
    const spec=SAMPLE[source]||{},at=spec.at||(spec.indexed?[47.5+index,19+index]:null),extra=typeof spec.row==='function'?spec.row(now):spec.row;
    const row={providerId:'live-'+index,source,kind:spec.kind||'disaster',title:'Fixture current '+source+' <img onerror="window.__liveXss=1">',summary:'Public data: safe text only',
      url:'https://example.org/public/'+index,observedAt:new Date(now-600000).toISOString(),...Object.fromEntries((FACT_FIELDS[source]||[]).map((key,i)=>[key,i+1])),
      ...(at?{lat:at[0],lon:at[1],locationMethod:spec.method||'provider',locationPrecision:spec.precision||'approximate'}:{}),...extra};
    // A second GDACS record at another level, so the inspector's severity chips have something to filter. A second EMSC record is the USGS
    // fixture quake as EMSC reports it: the maps draw it once (the USGS marker), the event lists keep both.
    const more=source==='GDACS'?[{providerId:'live-'+index+'-b',source,kind:'disaster',title:'Fixture GDACS green alert',summary:'Public data: second record',severity:'Green',observedAt:new Date(now-1200000).toISOString()}]
      :source==='EMSC'?[{providerId:'live-'+index+'-usgs',source,kind:'earthquake',title:'Fixture EMSC copy of the USGS quake',summary:'Public data: the same quake in both catalogues',url:'https://example.org/public/emsc-copy',
        observedAt:new Date(Date.parse(quake.time)+50).toISOString(),lat:quake.lat+0.02,lon:quake.lon+0.03,locationMethod:'provider',locationPrecision:'exact',severity:'high'}]:[];
    return [source,{source,status:'ok',observedAt:new Date(now-600000).toISOString(),timestamp:new Date(now).toISOString(),summary:spec.summary||'Fixture current '+source,
      attribution:source+' public source attribution',...(spec.metrics?{metrics:spec.metrics}:{}),observations:spec.rows===false?[]:[row,...more]}];
  }));
}
// The live sources of a sweep at `now`, as synthesis stores them (normalized at that time, rows stamped with their event ids).
const liveAt=(now,names=Object.keys(POLICIES))=>stampLiveEventIds(normalizeLiveSources(Object.fromEntries(Object.entries(liveSamples(now)).filter(([name])=>names.includes(name))),now));
// Sweep archive: the real SweepArchive, archive step and routes over the fixture's tmp dir. Five past sweeps an hour apart (the oldest a
// baseline) and the page's own snapshot as the newest, each with `changes` from buildChanges against the one before. The past sweeps carry
// every live source sampled at their own time (so a replayed one is current only under the frozen clock) except that the sweep an hour
// ago misses four (their records are new now), none of them has the USGS quake or the hostile record, and the extra sources change state:
// [code per sweep, -5 h .. -1 h] with 0 ok, 1 stale, 2 error, 3 disabled, null = not reported. The newest sweep has them all ok.
// /control?archive=empty|seed swaps the archive the routes read (an empty one: replay and matrix unavailable); seed is the default.
const HOUR=3600000,FLAGS=[{},{stale:true},{err:true},{disabled:true}];
const PAST={GDELT:[null,0,0,0,0],NOAA:[0,0,0,1,1],FRED:[0,2,0,0,0],WHO:[0,0,3,3,0],[HOSTILE]:[0,0,0,0,2]};
const MISSING_AN_HOUR_AGO=['GDACS','Aviation-SIGMET','IMF-PortWatch','ADSB-Military'];
const quietLog={warn(){},error(){},log(){}};
function pastSweep(hoursAgo,start){
  const time=start-hoursAgo*HOUR,timestamp=new Date(time).toISOString(),index=5-hoursAgo;
  const health=[...data.health.slice(0,4).map(row=>({...row,timestamp})),...Object.entries(PAST).filter(([,codes])=>codes[index]!==null).map(([n,codes])=>({n,err:false,...FLAGS[codes[index]],timestamp}))];
  const snapshot={...structuredClone(data),meta:{...data.meta,timestamp},health,earthquakes:[],newsFeed:data.newsFeed.filter(item=>!item.headline.includes(HOSTILE)),
    liveSources:liveAt(time,hoursAgo===1?Object.keys(POLICIES).filter(name=>!MISSING_AN_HOUR_AGO.includes(name)):undefined)};
  snapshot.events=buildEvents(snapshot,{now:time});snapshot.eventClusters=clusterEvents(snapshot.events);
  return snapshot;
}
// The briefing's timing of a snapshot: the health state of each source and a fixed run time, so the matrix has a "last run" column.
const timingOf=snapshot=>Object.fromEntries(snapshot.health.map((row,i)=>[row.n,{status:row.disabled?'disabled':row.err?'error':row.stale?'stale':'ok',ms:120+i*15}]));
const seededArchive=new SweepArchive(historyDir,{logger:quietLog}),emptyArchive=new SweepArchive(join(historyDir,'empty-archive'),{logger:quietLog});
let previousSweep=null;
for(const hoursAgo of [5,4,3,2,1]){const snapshot=pastSweep(hoursAgo,Date.parse(data.meta.timestamp));archiveSweep({archive:seededArchive,snapshot,timing:timingOf(snapshot),previous:previousSweep,log:quietLog});previousSweep=snapshot;}
// The newest archived sweep is the page's startup snapshot, without live sources: the fixture starts with them off because the other
// QA phases expect that. /control?liveSources=true changes only the page's data (its changes are counted against the -1 h sweep again,
// see rebuildEvents); the archive keeps this startup copy, so a replay of the newest sweep shows no live cards.
archiveSweep({archive:seededArchive,snapshot:data,timing:timingOf(data),previous:previousSweep,log:quietLog});
let archive=seededArchive;
const archiveView={retention:()=>archive.retention(),list:options=>archive.list(options),get:id=>archive.get(id),getRaw:id=>archive.getRaw(id),latest:()=>archive.latest(),healthSeries:options=>archive.healthSeries(options)};
installSweepRoutes(api,{archive:archiveView,getCurrent:()=>data});
installApiErrorHandler(api);
// Every rebuild of the page's events is a new sweep of the same kind: its changes are counted against the sweep an hour ago again.
function rebuildEvents(){data.events=buildEvents(data);data.eventClusters=clusterEvents(data.events);history.add(data.events);data.changes=buildChanges(previousSweep,data);recordRisk();}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/control') {
    if(url.searchParams.has('liveSources')){
      const enabled=url.searchParams.get('liveSources')==='true',samples=liveSamples(Date.now());
      // failed=group: the first source of each domain (policy order) reports an error; failed=all: every source does; any other value is
      // a comma-separated list of source names that fail (e.g. two sources of one domain).
      const failed=url.searchParams.get('failed'),hit=new Set(),named=failed?failed.split(','):[];
      if(failed)for(const sample of Object.values(samples)){const domain=domainOfSource(sample.source);if(failed==='all'||(failed==='group'&&!hit.has(domain))||named.includes(sample.source)){hit.add(domain);sample.status='error';sample.error='Fixture failure';}}
      data.liveSources=enabled?normalizeLiveSources(samples):[];
      if(enabled&&url.searchParams.get('expired')==='true')data.liveSources[0].observedAt='2025-01-01T00:00:00Z';
      // Rows carry eventId as in 2.9.0 snapshots; legacyIds=true keeps the 2.8.0 shape without it.
      if(url.searchParams.get('legacyIds')!=='true')data.liveSources=stampLiveEventIds(data.liveSources);
      rebuildEvents();
    }
    if(['empty','seed'].includes(url.searchParams.get('archive')))archive=url.searchParams.get('archive')==='empty'?emptyArchive:seededArchive;
    // update=true: a new live sweep (now) goes out to every open event stream, as the server's broadcast does.
    if(url.searchParams.get('update')==='true'){data.meta.timestamp=new Date().toISOString();rebuildEvents();for(const client of streams)client.write(`data: ${JSON.stringify({type:'update',data})}\n\n`);}
    if(['seed','newcritical','clear'].includes(url.searchParams.get('alerts')))seedAlerts(url.searchParams.get('alerts'));
    if(['en','hu','fr'].includes(url.searchParams.get('language')))fixtureLanguage=url.searchParams.get('language');
    online = url.searchParams.get('online') !== 'false';
    if (!online) for (const client of streams) client.end();
    res.end('ok'); return;
  }
  if (url.pathname === '/api/data') {
    if (!online) { res.writeHead(503); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return;
  }
  if (url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', refreshIntervalMinutes: 15, lastSweep: data.meta.timestamp, nextSweep: new Date(Date.now() + 900000).toISOString() })); return;
  }
  if (url.pathname === '/events') {
    if (!online) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    streams.add(res); res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    const timer = setTimeout(() => {
      data.meta.timestamp = new Date().toISOString();
      data.newsFeed[0].headline = 'Fixture SSE updated';
      rebuildEvents();
      res.write(`data: ${JSON.stringify({ type: 'update', data })}\n\n`);
    }, 3000);
    req.on('close', () => { clearTimeout(timer); streams.delete(res); }); return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/offline-shell') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(renderOfflineShell(readFileSync(new URL('../../dashboard/public/jarvis.html',import.meta.url),'utf8'),getLocaleForLanguage(fixtureLanguage)));return;
  }
  if (['/api/history','/api/export','/api/alerts','/api/sweeps','/api/changes','/api/source-health','/api/countries','/api/predictions','/api/briefing'].includes(url.pathname)||['/api/events/','/api/alerts/','/api/sweeps/','/api/countries/'].some(prefix=>url.pathname.startsWith(prefix))) { api(req,res);return; }
  if (url.pathname !== '/') {
    const root = resolve('dashboard/public');const file = resolve(root, '.' + url.pathname);
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      const type = {'.js':'application/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf'}[extname(file)] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type':type});res.end(readFileSync(file));return;
    }
    res.writeHead(404);res.end();return;
  }
  const html = readFileSync(new URL('../../dashboard/public/jarvis.html', import.meta.url), 'utf8')
    .replace(/^(let|const) D = .*;\s*$/m, () => `let D = ${inlineJson(data)};`)
    .replace('</head>', `<script>window.__CRUCIX_LOCALE__ ||= ${inlineJson(getLocaleForLanguage(fixtureLanguage))};</script></head>`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
});
server.listen(Number(process.env.QA_PORT || 3199), '127.0.0.1', () => console.log(`QA fixture http://127.0.0.1:${server.address().port}`));
