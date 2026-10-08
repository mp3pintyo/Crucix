(function(window){
  'use strict';
  const HOUR=3600000;
  const policies={Meteoalarm:{maxAgeMs:3*HOUR,observationMaxAgeMs:48*HOUR},GDACS:{maxAgeMs:6*HOUR,observationMaxAgeMs:72*HOUR},'NOAA-SWPC':{maxAgeMs:HOUR},ECB:{maxAgeMs:120*HOUR},'NASA-EONET':{maxAgeMs:72*HOUR},RIPEstat:{maxAgeMs:8*HOUR},'FIRST-EPSS':{maxAgeMs:48*HOUR},'MET-Norway':{maxAgeMs:8*HOUR},OONI:{maxAgeMs:24*HOUR},'IMF-PortWatch':{maxAgeMs:240*HOUR,observationMaxAgeMs:240*HOUR},EMSC:{maxAgeMs:12*HOUR,observationMaxAgeMs:26*HOUR},'Copernicus-EMS':{maxAgeMs:1080*HOUR,observationMaxAgeMs:720*HOUR},'Aviation-SIGMET':{maxAgeMs:3*HOUR,observationMaxAgeMs:24*HOUR},'ADSB-Military':{maxAgeMs:25*60000,observationMaxAgeMs:25*60000},'OpenSanctions-Index':{maxAgeMs:48*HOUR,observationMaxAgeMs:336*HOUR},'Federal-Register':{maxAgeMs:336*HOUR,observationMaxAgeMs:336*HOUR},'Energy-Charts-HU':{maxAgeMs:6*HOUR,observationMaxAgeMs:6*HOUR},'ENTSOG-HU':{maxAgeMs:72*HOUR,observationMaxAgeMs:72*HOUR},'Prediction-Markets':{maxAgeMs:12*HOUR,observationMaxAgeMs:12*HOUR},ThreatFox:{maxAgeMs:6*HOUR,observationMaxAgeMs:24*HOUR},HIBP:{maxAgeMs:336*HOUR,observationMaxAgeMs:720*HOUR},GPSJam:{maxAgeMs:96*HOUR,observationMaxAgeMs:96*HOUR},'WMO-SWIC':{maxAgeMs:3*HOUR,observationMaxAgeMs:24*HOUR},'UNHCR-Arrivals':{maxAgeMs:504*HOUR,observationMaxAgeMs:1440*HOUR},'SEC-8K':{maxAgeMs:2160*HOUR,observationMaxAgeMs:2160*HOUR}};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function time(value){
    if(typeof value!=='string'||value.length>128)return NaN;
    const match=value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/);
    if(!match||Number(match[2]||0)>23||Number(match[3]||0)>59||Number(match[4]||0)>59)return NaN;
    const day=new Date(match[1]+'T00:00:00Z');
    if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==match[1])return NaN;
    if(match[5]&&match[5]!=='Z'&&(Number(match[5].slice(1,3))>23||Number(match[5].slice(4))>59))return NaN;
    return Date.parse(value);
  }
  // Freshness is judged against CrucixClock (frozen at the snapshot's own time during a sweep replay); without it, the real time.
  function nowMs(){const clock=window.CrucixClock,value=clock&&typeof clock.now==='function'?clock.now():NaN;return Number.isFinite(value)?value:Date.now();}
  function fresh(value,limit,now){const ms=time(value);return Number.isFinite(ms)&&now-ms>=-300000&&now-ms<=limit;}
  function validRow(row,policy,now,source){
    if(!row||!fresh(row.observedAt||row.publishedAt,policy.observationMaxAgeMs||policy.maxAgeMs,now))return false;
    if(row.validUntil!==undefined&&(!Number.isFinite(time(row.validUntil))||time(row.validUntil)<=now))return false;
    if(source==='MET-Norway'||row.kind==='forecast'){
      const target=time(row.forecastAt),until=time(row.validUntil);
      if(!Number.isFinite(target)||!Number.isFinite(until)||Math.abs(target-now)>HOUR||until<=target||until-target>12*HOUR||until<=now)return false;
    }
    return true;
  }
  function state(source,now=nowMs()){
    if(source?.status==='error'||source?.error)return 'error';
    const policy=policies[source?.source];
    return policy && source?.status==='ok' && !source.stale && fresh(source.observedAt,policy.maxAgeMs,now) && (source.source!=='MET-Norway'||(Array.isArray(source.observations)&&source.observations.slice(0,100).some(row=>validRow(row,policy,now,source.source))))?'ok':'stale';
  }
  const limit=()=>Object.keys(policies).length;
  function observations(sources,now=nowMs()){
    return (Array.isArray(sources)?sources:[]).slice(0,limit()).flatMap(source=>{
      if(state(source,now)!=='ok')return [];
      const policy=policies[source.source];
      return (Array.isArray(source.observations)?source.observations:[]).slice(0,100).filter(row=>validRow(row,policy,now,source.source));
    });
  }
  // The rows the maps draw: current rows with coordinates. A quake that USGS and EMSC both report is drawn once: an earthquake row within
  // QUAKE_MS and QUAKE_KM of a USGS significant quake (D.earthquakes, its own markers) is left off the map; both events stay in the lists.
  // Measured in a live sweep on 2026-10-03: the same M4.7 near Korumburra was 0.05 s and 2.6 km apart in the two catalogues.
  const QUAKE_MS=60000,QUAKE_KM=100;
  const located=(lat,lon)=>typeof lat==='number'&&typeof lon==='number'&&Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180;
  function km(a,b){const r=d=>d*Math.PI/180,h=Math.sin(r(b.lat-a.lat)/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(r(b.lon-a.lon)/2)**2;return 12742*Math.asin(Math.min(1,Math.sqrt(h)));}
  function markerRows(sources,quakes,now=nowMs()){
    const usgs=(Array.isArray(quakes)?quakes:[]).slice(0,500).filter(q=>q&&located(q.lat,q.lon)).map(q=>({lat:q.lat,lon:q.lon,at:typeof q.time==='number'?q.time:time(q.time)})).filter(q=>Number.isFinite(q.at));
    return observations(sources,now).filter(row=>located(row.lat,row.lon)&&!(row.kind==='earthquake'&&usgs.some(q=>Math.abs(q.at-time(row.observedAt))<=QUAKE_MS&&km(q,row)<=QUAKE_KM)));
  }
  const stamp=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString().replace('T',' ').replace(/\.\d{3}Z$/,' UTC'):'—';
  function safeUrl(raw){try{const url=new URL(raw);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!Array.from(url.searchParams.keys()).some(key=>/^(?:api[-_]?key|token|secret|password|authorization|auth)$/i.test(key))?url.href:null;}catch{return null;}}
  function metricText(metrics){
    const rows=[];
    function walk(value,path='',depth=0){if(depth>3||!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value).slice(0,40)){const label=path?path+' / '+key:key;if(typeof item==='string'||typeof item==='number'||typeof item==='boolean')rows.push(label+': '+item);else walk(item,label,depth+1);if(rows.length>=8)return;}}
    walk(metrics);return rows.slice(0,8).join(' · ');
  }
  // One badge per known level that has records: glyph and count, so colour is never the only signal; the level name is spoken (.ri-sr) and shown as a tooltip.
  function badges(R,recs,t){
    const counts=R.countByLevel(recs);
    return R.LEVELS.filter(level=>level!=='unknown'&&counts[level]).map(level=>{const name=esc(t('inspector.level.'+level,level[0].toUpperCase()+level.slice(1)));return `<span class="sev sev-${level}" title="${name}"><i aria-hidden="true">${R.GLYPH[level]}</i>${counts[level]}<span class="ri-sr"> ${name}</span></span>`;}).join('');
  }
  // Domain groups (domains.js + lens-core.js; without them the flat card list). Under the `all` lens each group has a header button whose
  // state CrucixLens keeps (by default open when the group needs attention); another lens shows only its own group, open, with a plain
  // header. The cards inside are the cards of the flat list, unchanged. Rows without a domain stay ungrouped (all lens only).
  const GLYPHS={critical:'◆',high:'▲',watch:'●',info:'○'},CHIP_LIMIT=3;
  function grouped(cards,t,tr){
    const core=window.CrucixLensCore,domains=window.CrucixDomains,lens=window.CrucixLens;
    if(!core||!domains)return null;
    const active=core.normalize(lens&&typeof lens.get==='function'?lens.get():'all');
    const say=(key,fallback,count)=>esc(String(t('lenses.'+key,fallback)??fallback).split('{count}').join(String(count)));
    const groups=core.groupSources(cards,domains.domainOfSource).filter(group=>active==='all'?true:group.domain===active);
    if(!groups.length)return `<div class="empty-state">${say('noLiveSources','No live source belongs to this domain.')}</div>`;
    return groups.map(group=>{
      const body=group.rows.map(row=>row.html).join('');
      if(group.domain===null)return body;
      const id=esc(group.domain),sources=group.rows.length,records=group.rows.reduce((sum,row)=>sum+row.count,0);
      const counts=(sources===1?say('sourceCountOne','{count} source',sources):say('sourceCount','{count} sources',sources))+' · '+(records===1?say('recordCountOne','{count} record',records):say('recordCount','{count} records',records));
      const worst=group.worst?`<span class="lg-worst sev-${group.worst}"><i aria-hidden="true">${GLYPHS[group.worst]}</i> ${esc(t('inspector.level.'+group.worst,group.worst[0].toUpperCase()+group.worst.slice(1)))}</span>`:'';
      const off=group.rows.filter(row=>row.state!=='ok');
      const chips=off.slice(0,CHIP_LIMIT).map(row=>{const text=`${esc(row.source)}: ${tr(row.state,row.state==='error'?'Unavailable':'Expired')}`;return `<span class="lg-chip lg-${row.state}" title="${text}">${text}</span>`;}).join('')+(off.length>CHIP_LIMIT?`<span class="lg-chip lg-more">${say('moreSources','+{count} more',off.length-CHIP_LIMIT)}</span>`:'');
      const attention=group.attention?`<span class="lg-sr">${say('attention','Needs attention')}</span>`:'';
      const parts=`<span class="lg-line"><span class="lg-caret" aria-hidden="true">▸</span><span class="lg-name">${say(group.domain,group.domain)}</span>${worst}</span><span class="lg-line lg-sub"><span class="lg-counts">${counts}</span>${chips}</span>${attention}`;
      if(active!=='all')return `<section class="live-group" data-live-domain="${id}" data-attention="${group.attention}"><div class="live-group-head">${parts}</div><div class="live-group-body" id="live-group-${id}">${body}</div></section>`;
      const open=lens&&typeof lens.expanded==='function'?lens.expanded(group.domain,group.attention)===true:group.attention;
      return `<section class="live-group" data-live-domain="${id}" data-attention="${group.attention}"><button type="button" class="live-group-head" data-live-group="${id}" aria-expanded="${open}" aria-controls="live-group-${id}">${parts}</button><div class="live-group-body" id="live-group-${id}"${open?'':' hidden'}>${body}</div></section>`;
    }).join('');
  }
  // `events` is unused (the inspector pairs records by eventId); it stays so `now` keeps its position.
  function renderPanel(sources,t,events,now=nowMs()){
    const R=window.CrucixRecords,tr=(key,fallback)=>esc(t('liveSources.'+key,fallback));
    const providers=(Array.isArray(sources)?sources:[]).slice(0,limit()).filter(source=>source&&Object.hasOwn(policies,source.source));
    const cards=providers.map(source=>{
      const status=state(source,now),rows=observations([source],now),url=safeUrl(source.url);
      const partialForecast=source.source==='MET-Norway'&&rows.length!==(source.observations||[]).length;
      const recs=R?R.toRecords(rows,source.source):[],count=R?recs.length:rows.length;
      const detail=status==='ok'?(partialForecast?'':source.summary||metricText(source.metrics))||(count?'':t('liveSources.noRecords','No current records in the watched scope')):'';
      const content=status==='ok'?(detail?`<p class="live-summary">${esc(detail)}</p>`:''):`<p class="live-summary">${status==='error'?tr('unavailable','Source unavailable'):tr('expired','Provider data expired or its timestamp is unknown. Live records are hidden.')}</p>`;
      const top=R?R.sortRecords(recs,'severity').slice(0,3).map(rec=>`<li>${esc(rec.title)}</li>`).join(''):'';
      const overview=count?`<div class="live-meta"><span>${count} ${tr('records','current records')}</span>${R?badges(R,recs,t):''}</div>${top?`<ul class="live-top" aria-label="${tr('topRecords','Top records')}">${top}</ul>`:''}`:'';
      const open=status==='ok'?`<button type="button" class="live-open" data-open-records="${esc(source.source)}" aria-controls="record-inspector">${tr('openRecords','Open records')}</button>`:'';
      const licenseUrl=safeUrl(source.licenseUrl);
      return {source:source.source,state:status,count,levels:R?R.countByLevel(recs):{},html:`<article class="live-source" data-live-source="${esc(source.source)}" data-live-state="${status}"${R?.store.get().source===source.source?' data-selected="true"':''}><div class="live-source-head"><h4>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.source)} ↗</a>`:esc(source.source)}</h4><span class="source-state ${status}">${tr(status,status==='ok'?'Current':status==='error'?'Unavailable':'Expired')}</span></div><small>${tr('providerTime','Provider time')}: ${esc(stamp(source.observedAt))}</small>${content}${overview}${open}${source.attribution||source.rights?`<small class="live-attribution">${esc(source.attribution)} ${esc(source.rights)}</small>`:''}${source.license?`<small>${licenseUrl?'<a href="'+esc(licenseUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(source.license)+'</a>':esc(source.license)}</small>`:''}</article>`};
    });
    const list=cards.length?grouped(cards,t,tr)??cards.map(card=>card.html).join(''):'<div class="empty-state">'+tr('waiting','Waiting for the first collection')+'</div>';
    // The badge counts the cards the panel shows: under a domain lens only that domain's (current / shown), like the source-health badge.
    const core=window.CrucixLensCore,lens=window.CrucixLens,active=core&&window.CrucixDomains?core.normalize(lens&&typeof lens.get==='function'?lens.get():'all'):'all';
    const shown=active==='all'?cards:cards.filter(card=>core.matchesSource(active,card.source));
    return `<div class="g-panel live-sources-panel"><div class="sec-head"><h3>${tr('title','Current public data')}</h3><span class="badge">${shown.filter(card=>card.state==='ok').length}/${shown.length}</span></div><p class="live-help">${tr('help','Only records within each provider’s freshness window are shown. Forecasts and model estimates are labelled.')}</p><div class="live-source-list">${list}</div></div>`;
  }
  window.CrucixLiveSources={policies,state,observations,markerRows,renderPanel};
})(window);
