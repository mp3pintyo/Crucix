(function(window,document){
  'use strict';
  // "Country risk": the right-rail panel (panelHtml) over the `risk` summary of a sweep snapshot (lib/intelligence/risk.mjs summarize():
  // {version, at, top:[{iso3,name,score,change24h,coverage,convergence}], counts:{scored,high}, calibration:{n,brier,skill}|null}).
  // The panel is NOT filtered by the domain lens: a country has no domain (spec section 1), so the ranking is the same under every lens.
  // During a sweep replay the page's D is the archived snapshot, so the panel shows that sweep's own `risk`; the country sheet and the
  // briefing read the live store, so their entry points are off then (rows aria-disabled, the note says why).
  // Honesty rules: a missing 24 h change is "–" ("no history yet"), never 0; coverage is the model weight that had data (missing components
  // are left out, not guessed); the track record says "not enough resolved predictions yet" below 30 resolved rows.
  // mount(options):
  //   t(key, fallback), locale     the page's text (groups `risk`, `country`, `briefing`, `intelligence.kind_*`) and number locale
  //   getRisk()                    the snapshot's own risk object (the page's D.risk)
  //   isReplay()                   a sweep replay holds the page
  //   openCountry(iso3), openBriefing(scope)  the dialogs (default: CrucixCountry.open / CrucixBriefing.open)
  //   fetchJson(url)               reads GET /api/countries for the palette's country names (without it the dialogs are off: file pages, offline shell)
  // The dialogs, the palette items and the map click work only while getRisk() gives an object (asked at click time): with RISK_ENABLED=false the
  // API routes do not exist (404) and snapshots carry no `risk` (nor does a replayed sweep archived before 2.13); the panel then says so.
  // update(risk) runs before every render of the page (it keeps the focus of a panel row across the re-render); paletteItems() gives the
  // command palette its "Open country: <name>" and briefing actions; shapeIso3(id, name) resolves a flat-map shape to its ISO3 code.
  const ISO3=/^[A-Z]{3}$/,TOP=10,TRACK_MIN=30,MAX_NAME=120;
  // The vendored world-atlas shapes (dashboard/public/vendor/countries-110m-2.0.2.json): ISO numeric id + ISO3 code, as the server's
  // gazetteer resolves them (lib/intelligence/countries.mjs countryByNum; test/risk-ui.test.mjs keeps the two equal). The three shapes
  // without a numeric id resolve by name, as lib/intelligence/geo.mjs does.
  const SHAPES='004AFG 008ALB 010ATA 012DZA 024AGO 031AZE 032ARG 036AUS 040AUT 044BHS 050BGD 051ARM 056BEL 064BTN 068BOL 070BIH 072BWA 076BRA 084BLZ 090SLB 096BRN 100BGR 104MMR 108BDI 112BLR 116KHM 120CMR 124CAN 140CAF 144LKA 148TCD 152CHL 156CHN 158TWN 170COL 178COG 180COD 188CRI 191HRV 192CUB 196CYP 203CZE 204BEN 208DNK 214DOM 218ECU 222SLV 226GNQ 231ETH 232ERI 233EST 238FLK 242FJI 246FIN 250FRA 260ATF 262DJI 266GAB 268GEO 270GMB 275PSE 276DEU 288GHA 300GRC 304GRL 320GTM 324GIN 328GUY 332HTI 340HND 348HUN 352ISL 356IND 360IDN 364IRN 368IRQ 372IRL 376ISR 380ITA 384CIV 388JAM 392JPN 398KAZ 400JOR 404KEN 408PRK 410KOR 414KWT 417KGZ 418LAO 422LBN 426LSO 428LVA 430LBR 434LBY 440LTU 442LUX 450MDG 454MWI 458MYS 466MLI 478MRT 484MEX 496MNG 498MDA 499MNE 504MAR 508MOZ 512OMN 516NAM 524NPL 528NLD 540NCL 548VUT 554NZL 558NIC 562NER 566NGA 578NOR 586PAK 591PAN 598PNG 600PRY 604PER 608PHL 616POL 620PRT 624GNB 626TLS 630PRI 634QAT 642ROU 643RUS 646RWA 682SAU 686SEN 688SRB 694SLE 703SVK 704VNM 705SVN 706SOM 710ZAF 716ZWE 724ESP 728SSD 729SDN 732ESH 740SUR 748SWZ 752SWE 756CHE 760SYR 762TJK 764THA 768TGO 780TTO 784ARE 788TUN 792TUR 795TKM 800UGA 804UKR 807MKD 818EGY 826GBR 834TZA 840USA 854BFA 858URY 860UZB 862VEN 887YEM 894ZMB';
  const SHAPE_NAMES={'N. Cyprus':'CYP',Somaliland:'SOM',Kosovo:'XKX'};
  const BY_NUM=new Map(SHAPES.split(' ').map(entry=>[entry.slice(0,3),entry.slice(3)]));
  const COPY={title:'Country risk',version:'Model v{version}',summary:'{scored} countries scored · {high} at 70 or above',intro:'A heuristic 0–100 index from recorded events, VIEWS forecasts and INFORM baselines; not filtered by the domain lens.',
    unavailable:'Country risk is not available.',empty:'No country has a risk score yet.',rankLabel:'Countries by risk score',briefing:'Briefing',score:'Score {score} of 100',
    changeUp:'Up {value} in 24 h',changeDown:'Down {value} in 24 h',changeFlat:'No change in 24 h',changeNone:'No history yet',coverage:'{percent}% coverage',
    coverageHelp:'The components with data carry {percent}% of the model weight; missing ones are left out, not guessed. The country sheet lists them.',
    convergence:'Convergence',convergenceHelp:'Several event types at high or above within 24 h: {kinds}',trackTitle:'Track record',
    trackHelp:'Logged 7-day predictions (at least one new high or critical event in the country), scored after 7 days.',trackNotEnough:'Not enough resolved predictions yet (n={n}; 30 needed).',
    trackStats:'Resolved: {n} · Brier {brier} · skill {skill}',trackSkillHelp:'Skill compares the Brier score with always forecasting the base rate: above 0 is better than the base rate, below 0 worse.',
    anomaliesTitle:'Unusual activity',anomaliesHelp:'Located events in the last 24 hours against the same country’s own previous 24-hour windows (mean and spread; at least 10 windows needed). Weekday patterns are not modelled.',anomaliesNone:'Nothing unusual against each country’s own recent history.',anomalyRow:'{current} events, usually {mean} (z {z})',
    spikesTitle:'Trending terms',spikesHelp:'Words in far more headlines than usual in the last two hours: at least 4 headlines from at least 2 sources and more than 3 times the usual count.',spikesNotReady:'Collecting a baseline: {hours} of the 24 hours of headlines needed.',spikesNone:'No term stands out against its usual count.',spikeRow:'{count} headlines, usually {baseline} · {sources} sources',
    timelineTitle:'Threat timeline',timelineHelp:'Located events by UTC day for the last seven days and threat level (today is a partial day). The trend compares critical plus high events of the last three complete days with the three before.',
    timelineNotReady:'Collecting history: {days} of 3 days needed for a trend.',timelineTrend_worsening:'Trend: worsening',timelineTrend_easing:'Trend: easing',timelineTrend_steady:'Trend: steady',
    timelineRow:'{total} events · {critical} critical · {high} high · {watch} watch',
    thermalTitle:'Thermal escalation',thermalHelp:'Satellite heat detections above 10 MW (NASA FIRMS, strongest 300 per region) grouped within 20 km and compared with the same 0.5° cell’s own previous days. Heat, not a cause: a prompt to look.',
    thermalNotReady:'Collecting a baseline: {days} of about 5 days of detections needed.',thermalNone:'No heat cluster stands out against its cell’s usual activity.',thermalSpike:'Spike',thermalPersistent:'Persistent',thermalElevated:'Elevated',
    thermalRow:'{count} detections, {frp} MW, usually {usual} a day · burning {hours} h',
    replayNote:'The country sheet and the briefing read the live store, so they are off during the replay. The ranking shown is the replayed sweep’s own.'};
  let opts=null,listed=[],listAt='',listSeq=0;
  const log=error=>{try{console.error('[risk]',error);}catch{}};
  const guarded=fn=>(...args)=>{try{return fn(...args);}catch(error){log(error);}};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  // Plain text; escaped only where it goes into markup.
  function tx(path,fallback){try{const value=opts&&typeof opts.t==='function'?opts.t(path,fallback):fallback;return typeof value==='string'&&value?value:fallback;}catch{return fallback;}}
  function fill(text,values){for(const [from,to] of Object.entries(values||{}))text=text.split('{'+from+'}').join(String(to));return text;}
  const say=(key,values)=>fill(tx('risk.'+key,COPY[key]),values);
  function inReplay(){try{return !!(opts&&typeof opts.isReplay==='function'&&opts.isReplay());}catch{return false;}}
  // The dialogs need the live API (GET /api/countries/:iso3, POST /api/briefing): not on file pages and in the offline shell.
  const dialogs=()=>!!opts&&typeof opts.fetchJson==='function';
  // ... and the risk step: the page has a risk summary (spec: RISK_ENABLED=false leaves no routes and no `risk`). Asked when used, never cached.
  function ready(){if(!dialogs())return false;try{return typeof opts.getRisk==='function'&&isObject(opts.getRisk());}catch{return false;}}
  function number(value,digits,signed){
    const sign=signed&&value>0?'+':'';
    try{return sign+new Intl.NumberFormat(opts&&opts.locale||undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);}catch{return sign+value.toFixed(digits);}
  }
  const kindName=kind=>tx('intelligence.kind_'+kind,kind);

  /** The ISO3 code of a flat-map shape: its ISO numeric id (string or number), else its name for the three shapes without one; null otherwise. */
  function shapeIso3(id,name){
    const key=typeof id==='number'&&Number.isInteger(id)?String(id).padStart(3,'0'):typeof id==='string'?id:'';
    if(BY_NUM.has(key))return BY_NUM.get(key);
    return typeof name==='string'&&Object.hasOwn(SHAPE_NAMES,name)?SHAPE_NAMES[name]:null;
  }

  // ===== The object =====
  const cleanName=(value,iso3)=>typeof value==='string'&&value.trim()?value.trim().slice(0,MAX_NAME):iso3;
  // The server language's name when the server sent one (older sweeps have none), else the English `name`; the English one stays a palette keyword.
  const shownName=item=>cleanName(typeof item.displayName==='string'&&item.displayName.trim()?item.displayName:item.name,item.iso3);
  function row(item){
    const score=Math.max(0,Math.min(100,Math.round(item.score)));
    const change=typeof item.change24h==='number'&&Number.isFinite(item.change24h)?Math.round(item.change24h):null;
    const coverage=typeof item.coverage==='number'&&Number.isFinite(item.coverage)&&item.coverage>=0&&item.coverage<=1?Math.round(item.coverage*100):null;
    const conv=isObject(item.convergence)&&item.convergence.active===true&&Array.isArray(item.convergence.kinds)?item.convergence.kinds.filter(kind=>typeof kind==='string'&&kind).slice(0,12).map(kind=>kind.slice(0,40)):null;
    return {iso3:item.iso3,name:shownName(item),english:cleanName(item.name,item.iso3),score,change,coverage,kinds:conv};
  }
  // The trending terms and the unusual-activity list of the summary (2.23; absent in older sweeps): every field checked and cut.
  const TERM=/^[\p{L}\p{N}][\p{L}\p{N}-]{2,29}$/u,LEVEL_WORDS=['moderate','high','critical'];
  function readSpikes(value){
    if(!isObject(value))return null;
    const items=(Array.isArray(value.items)?value.items:[]).filter(item=>isObject(item)&&typeof item.term==='string'&&TERM.test(item.term)&&Number.isSafeInteger(item.count)&&item.count>0&&typeof item.ratio==='number'&&Number.isFinite(item.ratio))
      .slice(0,8).map(item=>({term:item.term,count:item.count,baseline:typeof item.baseline==='number'&&Number.isFinite(item.baseline)?item.baseline:0,ratio:item.ratio,level:item.level==='high'?'high':'moderate',
        sources:(Array.isArray(item.sources)?item.sources:[]).filter(name=>typeof name==='string').slice(0,4).map(name=>name.slice(0,40))}));
    return {ready:value.ready===true,observedHours:Number.isSafeInteger(value.observedHours)?value.observedHours:0,items};
  }
  // The escalating heat clusters of FIRMS (2.35; absent without FIRMS data): every field checked and cut.
  const THERMAL_STATUS=['spike','persistent','elevated'];
  function readThermal(value){
    if(!isObject(value))return null;
    const num=entry=>typeof entry==='number'&&Number.isFinite(entry);
    const items=(Array.isArray(value.items)?value.items:[]).filter(item=>isObject(item)&&THERMAL_STATUS.includes(item.status)&&num(item.lat)&&num(item.lon)&&Number.isSafeInteger(item.count)&&item.count>0&&num(item.frp))
      .slice(0,12).map(item=>({region:cleanName(item.region,'').slice(0,60),lat:item.lat,lon:item.lon,count:item.count,frp:Math.round(item.frp),status:item.status,high:item.relevance==='high',usual:num(item.usual)?item.usual:0,hours:Number.isSafeInteger(item.hours)?item.hours:0,
        site:typeof item.site==='string'?item.site.slice(0,80):''}));
    return {ready:value.ready===true,observedDays:Number.isSafeInteger(value.observedDays)?value.observedDays:0,items};
  }
  // The seven-day threat timeline of the summary (2.36; absent in older sweeps): every field checked and cut.
  const TL_LEVELS=['critical','high','watch','info'],TL_TRENDS=['worsening','easing','steady'];
  function readTimeline(value){
    if(!isObject(value)||!Array.isArray(value.days))return null;
    const days=value.days.filter(item=>isObject(item)&&typeof item.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(item.day)).slice(0,7).map(item=>{
      const row={day:item.day};for(const level of TL_LEVELS)row[level]=Number.isSafeInteger(item[level])&&item[level]>=0?item[level]:0;return row;});
    return {ready:value.ready===true,observedDays:Number.isSafeInteger(value.observedDays)?value.observedDays:0,days,trend:TL_TRENDS.includes(value.trend)?value.trend:null};
  }
  function readAnomalies(value){
    if(!Array.isArray(value))return null;
    return value.filter(item=>isObject(item)&&typeof item.iso3==='string'&&ISO3.test(item.iso3)&&Number.isSafeInteger(item.current)&&typeof item.mean==='number'&&Number.isFinite(item.mean)&&typeof item.z==='number'&&Number.isFinite(item.z))
      .slice(0,5).map(item=>({iso3:item.iso3,name:shownName(item),current:item.current,mean:item.mean,z:item.z,level:LEVEL_WORDS.includes(item.level)?item.level:'moderate'}));
  }
  // null when `risk` is not an object (no sweep yet, RISK_ENABLED=false or a failed step).
  function read(risk){
    if(!isObject(risk))return null;
    const top=Array.isArray(risk.top)?risk.top.filter(item=>isObject(item)&&typeof item.iso3==='string'&&ISO3.test(item.iso3)&&typeof item.score==='number'&&Number.isFinite(item.score)).slice(0,TOP).map(row):[];
    const counts=isObject(risk.counts)?risk.counts:{},count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
    return {version:Number.isSafeInteger(risk.version)?risk.version:null,top,scored:count(counts.scored),high:count(counts.high),calibration:isObject(risk.calibration)?risk.calibration:null,spikes:readSpikes(risk.spikes),anomalies:readAnomalies(risk.anomalies),thermal:readThermal(risk.thermal),timeline:readTimeline(risk.timeline)};
  }

  // ===== Markup =====
  function changeTag(value){
    if(value===null){const text=say('changeNone');return `<span class="rk-chg" data-dir="none" title="${esc(text)}"><span aria-hidden="true">–</span><span class="rk-sr">${esc(text)}</span></span>`;}
    const dir=value>0?'up':value<0?'down':'flat',glyph=dir==='up'?'▲':dir==='down'?'▼':'–',shown=dir==='up'?'+'+value:dir==='down'?'-'+Math.abs(value):'0';
    const text=say(dir==='up'?'changeUp':dir==='down'?'changeDown':'changeFlat',{value:Math.abs(value)});
    return `<span class="rk-chg" data-dir="${dir}" title="${esc(text)}"><span aria-hidden="true"><i>${glyph}</i> ${shown}</span><span class="rk-sr">${esc(text)}</span></span>`;
  }
  function coverageTag(percent){
    if(percent===null)return '';
    return `<span class="rk-cov" title="${esc(say('coverageHelp',{percent}))}">${esc(say('coverage',{percent}))}</span>`;
  }
  function convergenceTag(kinds){
    if(!kinds||!kinds.length)return '';
    const text=say('convergenceHelp',{kinds:kinds.map(kindName).join(', ')});
    return `<span class="rk-conv" title="${esc(text)}"><i aria-hidden="true">◆</i> ${esc(say('convergence'))}<span class="rk-sr">: ${esc(text)}</span></span>`;
  }
  const band=score=>score>=70?'high':score>=40?'elevated':score>=10?'watch':'low';
  function rowHtml(item,index,off){
    const disabled=off?' aria-disabled="true" aria-describedby="countryRiskReplay"':'';
    const inner=`<span class="rk-rank" aria-hidden="true">${index+1}</span><span class="rk-name">${esc(item.name)}</span><span class="rk-score" data-band="${band(item.score)}"><span class="rk-bar" aria-hidden="true"><span class="rk-fill" style="width:${item.score}%"></span></span><span class="rk-num" aria-hidden="true">${item.score}</span><span class="rk-sr">${esc(say('score',{score:item.score}))}</span></span><span class="rk-meta">${changeTag(item.change)}${coverageTag(item.coverage)}${convergenceTag(item.kinds)}</span>`;
    return `<li class="rk-item">${dialogs()||off?`<button type="button" class="rk-row" data-risk-country="${item.iso3}"${disabled}>${inner}</button>`:`<div class="rk-row">${inner}</div>`}</li>`;
  }
  function track(calibration){
    const n=calibration&&Number.isSafeInteger(calibration.n)&&calibration.n>=0?calibration.n:0;
    const enough=!!calibration&&n>=TRACK_MIN&&typeof calibration.brier==='number'&&Number.isFinite(calibration.brier);
    const body=enough
      ?`<p class="rk-stats" data-risk-state="scored">${esc(say('trackStats',{n,brier:number(calibration.brier,3),skill:typeof calibration.skill==='number'&&Number.isFinite(calibration.skill)?number(calibration.skill,2,true):'—'}))}</p><p class="rk-help">${esc(say('trackSkillHelp'))}</p>`
      :`<p class="rk-calm" data-risk-state="notEnough">${esc(say('trackNotEnough',{n}))}</p>`;
    return `<section class="rk-track" aria-labelledby="countryRiskTrack"><h4 id="countryRiskTrack">${esc(say('trackTitle'))}</h4><p class="rk-help">${esc(say('trackHelp'))}</p>${body}</section>`;
  }
  // Unusual activity: located events of the last 24 hours against the country's own previous 24-hour windows (Welford z-score).
  function anomalies(list,off){
    if(list===null)return '';
    const rows=list.map(item=>{
      const inner=`<span class="rk-name">${esc(item.name)}</span><span class="rk-an" data-level="${item.level}">${esc(say('anomalyRow',{current:item.current,mean:number(item.mean,1),z:number(item.z,1)}))}</span>`;
      return `<li class="rk-item">${dialogs()||off?`<button type="button" class="rk-row" data-risk-country="${item.iso3}"${off?' aria-disabled="true" aria-describedby="countryRiskReplay"':''}>${inner}</button>`:`<div class="rk-row">${inner}</div>`}</li>`;
    }).join('');
    return `<section class="rk-track rk-signals" aria-labelledby="countryRiskAnomalies"><h4 id="countryRiskAnomalies">${esc(say('anomaliesTitle'))}</h4><p class="rk-help">${esc(say('anomaliesHelp'))}</p>${rows?`<ul class="rk-list">${rows}</ul>`:`<p class="rk-calm" data-risk-state="none">${esc(say('anomaliesNone'))}</p>`}</section>`;
  }
  // Trending terms: words in many more headlines than usual in the last two hours, from at least two sources.
  function spikes(value){
    if(value===null)return '';
    const body=!value.ready?`<p class="rk-calm" data-risk-state="notReady">${esc(say('spikesNotReady',{hours:value.observedHours}))}</p>`
      :value.items.length?`<ul class="rk-list">${value.items.map(item=>`<li class="rk-item"><div class="rk-row"><span class="rk-name">${esc(item.term)}</span><span class="rk-an" data-level="${item.level}">${esc(say('spikeRow',{count:item.count,baseline:number(item.baseline,1),sources:item.sources.length}))}</span></div></li>`).join('')}</ul>`
      :`<p class="rk-calm" data-risk-state="none">${esc(say('spikesNone'))}</p>`;
    return `<section class="rk-track rk-signals" aria-labelledby="countryRiskSpikes"><h4 id="countryRiskSpikes">${esc(say('spikesTitle'))}</h4><p class="rk-help">${esc(say('spikesHelp'))}</p>${body}</section>`;
  }
  // Threat timeline: located events per UTC day for the last seven days by threat level, with a trend label (critical plus high, last three complete days against the three before).
  function timeline(value){
    if(value===null||!value.days.length)return '';
    const total=day=>TL_LEVELS.reduce((sum,level)=>sum+day[level],0),most=Math.max(1,...value.days.map(total));
    const rows=value.days.map(day=>{
      const all=total(day),bar='█'.repeat(all?Math.max(1,Math.round(all/most*20)):0);
      return `<li class="rk-item"><div class="rk-row"><span class="rk-name">${esc(day.day.slice(5))}</span><span class="rk-an" data-level="${day.critical?'critical':day.high?'high':'moderate'}"><span aria-hidden="true">${bar} </span>${esc(say('timelineRow',{total:all,critical:day.critical,high:day.high,watch:day.watch}))}</span></div></li>`;
    }).join('');
    const trend=value.ready&&value.trend?`<p class="rk-sum" data-risk-trend="${value.trend}">${esc(say('timelineTrend_'+value.trend))}</p>`:`<p class="rk-calm" data-risk-state="notReady">${esc(say('timelineNotReady',{days:value.observedDays}))}</p>`;
    return `<section class="rk-track rk-signals" aria-labelledby="countryRiskTimeline"><h4 id="countryRiskTimeline">${esc(say('timelineTitle'))}</h4><p class="rk-help">${esc(say('timelineHelp'))}</p>${trend}<ul class="rk-list">${rows}</ul></section>`;
  }
  // Heat clusters that are unusual for the ground they burn on (FIRMS detections above 10 MW against the cell's own previous days).
  function thermal(value){
    if(value===null)return '';
    const word={spike:'thermalSpike',persistent:'thermalPersistent',elevated:'thermalElevated'};
    const level=item=>item.status==='spike'?(item.high?'critical':'high'):item.status==='persistent'?(item.high?'high':'moderate'):'moderate';
    const body=!value.ready?`<p class="rk-calm" data-risk-state="notReady">${esc(say('thermalNotReady',{days:value.observedDays}))}</p>`
      :value.items.length?`<ul class="rk-list">${value.items.map(item=>`<li class="rk-item"><div class="rk-row"><span class="rk-name">${esc(item.region)} · ${esc(item.lat.toFixed(1))}, ${esc(item.lon.toFixed(1))}${item.site?` · ${esc(item.site)}`:''}</span><span class="rk-an" data-level="${level(item)}">${esc(say(word[item.status]))}: ${esc(say('thermalRow',{count:item.count,frp:item.frp,usual:number(item.usual,1),hours:item.hours}))}</span></div></li>`).join('')}</ul>`
      :`<p class="rk-calm" data-risk-state="none">${esc(say('thermalNone'))}</p>`;
    return `<section class="rk-track rk-signals" aria-labelledby="countryRiskThermal"><h4 id="countryRiskThermal">${esc(say('thermalTitle'))}</h4><p class="rk-help">${esc(say('thermalHelp'))}</p>${body}</section>`;
  }
  // options (tests and callers that know better): replay.
  function build(risk,options){
    const o=isObject(options)?options:{},replay=typeof o.replay==='boolean'?o.replay:inReplay(),data=read(risk);
    const brief=dialogs()||replay?`<button type="button" class="rk-brief" data-risk-briefing aria-haspopup="dialog"${replay?' aria-disabled="true" aria-describedby="countryRiskReplay"':''}>${esc(say('briefing'))}</button>`:'';
    const head=`<div class="sec-head"><h3 id="countryRiskTitle" tabindex="-1">${esc(say('title'))}</h3>${data&&data.version!==null?`<span class="rk-ver">${esc(say('version',{version:data.version}))}</span>`:''}${data?brief:''}</div>`;
    const note=replay?`<p class="rk-note rk-replay" id="countryRiskReplay">${esc(say('replayNote'))}</p>`:'';
    let main;
    if(!data)main=`<p class="rk-calm" data-risk-state="unavailable">${esc(say('unavailable'))}</p>`;
    else{
      const summary=data.scored!==null&&data.high!==null?`<p class="rk-sum">${esc(say('summary',{scored:data.scored,high:data.high}))}</p>`:'';
      const list=data.top.length?`<ol class="rk-list" aria-label="${esc(say('rankLabel'))}">${data.top.map((item,index)=>rowHtml(item,index,replay)).join('')}</ol>`:`<p class="rk-calm" data-risk-state="empty">${esc(say('empty'))}</p>`;
      main=`<p class="rk-intro">${esc(say('intro'))}</p>${summary}${list}${anomalies(data.anomalies,replay)}${timeline(data.timeline)}${spikes(data.spikes)}${thermal(data.thermal)}${track(data.calibration)}`;
    }
    return `<div class="g-panel risk-panel" id="countryRiskPanel" role="region" aria-labelledby="countryRiskTitle"${replay?' data-replay="true"':''}>${head}${note}${main}</div>`;
  }
  function panelHtml(risk,options){try{return build(risk,options);}catch(error){log(error);return '';}}

  // ===== Focus across the page's re-render =====
  // The page rebuilds the rails with innerHTML after update(): the focused row (or the heading) gets the focus back in a microtask.
  function spot(){
    const panel=document.getElementById('countryRiskPanel'),active=document.activeElement;
    if(!panel||!active||typeof panel.contains!=='function'||!panel.contains(active))return null;
    if(active.id==='countryRiskTitle')return {title:true};
    const code=typeof active.getAttribute==='function'?active.getAttribute('data-risk-country'):null;
    if(typeof code==='string')return {code};
    return typeof active.getAttribute==='function'&&active.getAttribute('data-risk-briefing')!==null?{brief:true}:null;
  }
  function restore(place){
    const panel=document.getElementById('countryRiskPanel');
    if(!panel)return;
    const target=place.title?panel.querySelector('#countryRiskTitle'):place.brief?panel.querySelector('[data-risk-briefing]'):[...panel.querySelectorAll('[data-risk-country]')].find(node=>node.getAttribute('data-risk-country')===place.code)||panel.querySelector('#countryRiskTitle');
    if(target&&target!==document.activeElement&&typeof target.focus==='function')target.focus({preventScroll:true});
  }
  // A new snapshot: the palette's country list is read again once per risk step (never during a replay: it is live data).
  function update(risk){
    if(!opts)return;
    const place=spot();
    if(place)Promise.resolve().then(guarded(()=>restore(place)));
    const at=isObject(risk)&&typeof risk.at==='string'?risk.at:'';
    if(!at||at===listAt||!dialogs()||inReplay())return;
    listAt=at;
    const mine=++listSeq;
    let request;
    try{request=Promise.resolve(opts.fetchJson('/api/countries'));}catch(error){request=Promise.reject(error);}
    request.then(data=>{
      if(mine!==listSeq||!isObject(data)||!Array.isArray(data.countries))return;
      listed=data.countries.filter(item=>isObject(item)&&typeof item.iso3==='string'&&ISO3.test(item.iso3)).slice(0,250).map(item=>({iso3:item.iso3,name:shownName(item),english:cleanName(item.name,item.iso3),score:typeof item.score==='number'&&Number.isFinite(item.score)?Math.round(item.score):null}));
    },()=>{if(mine===listSeq)listAt='';}).catch(log);
  }

  // ===== The palette =====
  // "Country risk briefing", then "Open country: <name>" for every country the page knows: the ranked ones first (the snapshot's top and the
  // scored list of /api/countries), then every flat-map shape (their names from the vendored topojson). Off during a replay and without the API.
  function shapeNames(){
    const world=window.__CRUCIX_WORLD_GEOMETRY__,list=[];
    try{for(const geometry of world.objects.countries.geometries){const iso3=shapeIso3(geometry.id,geometry.properties&&geometry.properties.name);if(iso3)list.push({iso3,name:cleanName(geometry.properties&&geometry.properties.name,iso3),score:null});}}catch{}
    return list;
  }
  function paletteItems(){
    if(!ready()||inReplay())return [];
    const items=[{id:'briefing',group:'action',label:tx('briefing.paletteAction','Country risk briefing'),hint:'',keywords:[tx('briefing.title','Briefing'),say('title')],run:()=>openBriefing('global')}];
    let top=[];try{const data=read(typeof opts.getRisk==='function'?opts.getRisk():null);top=data?data.top:[];}catch(error){log(error);}
    const seen=new Map();
    for(const item of [...top,...listed,...shapeNames()]){
      const known=seen.get(item.iso3);
      if(known){if(item.name!==known.name&&!known.keywords.includes(item.name))known.keywords.push(item.name);continue;}
      seen.set(item.iso3,{iso3:item.iso3,name:item.name,score:item.score,keywords:item.english&&item.english!==item.name?[item.iso3,item.english]:[item.iso3]});
    }
    for(const country of seen.values()){
      const hint=country.score!==null?tx('country.paletteHint','Risk score {score}').split('{score}').join(String(country.score)):tx('country.paletteHintNone','Country sheet');
      items.push({id:'country:'+country.iso3,group:'action',label:tx('country.paletteOpen','Open country: {name}').split('{name}').join(country.name),hint,keywords:country.keywords,run:()=>openCountry(country.iso3)});
    }
    return items;
  }

  // ===== Events =====
  function openCountry(iso3){
    if(!opts||!ISO3.test(iso3))return false;
    const fn=typeof opts.openCountry==='function'?opts.openCountry:window.CrucixCountry&&window.CrucixCountry.open;
    return typeof fn==='function'?fn(iso3):false;
  }
  function openBriefing(scope){
    if(!opts)return false;
    const fn=typeof opts.openBriefing==='function'?opts.openBriefing:window.CrucixBriefing&&window.CrucixBriefing.open;
    return typeof fn==='function'?fn(scope):false;
  }
  function onClick(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target:null;
    if(!target||!opts)return;
    const rowNode=target.closest('[data-risk-country]'),brief=rowNode?null:target.closest('[data-risk-briefing]'),node=rowNode||brief;
    if(!node)return;
    // A replay holds the page: the entry points are off (the note under the heading says why).
    if(inReplay()||node.getAttribute('aria-disabled')==='true'||!ready())return;
    if(rowNode){const code=rowNode.getAttribute('data-risk-country');if(typeof code==='string'&&ISO3.test(code))Promise.resolve(openCountry(code)).catch(log);return;}
    Promise.resolve(openBriefing('global')).catch(log);
  }
  function mount(options){
    if(opts||!options||typeof options!=='object')return false;
    opts=options;
    document.addEventListener('click',guarded(onClick));
    return true;
  }
  window.CrucixRisk=Object.freeze({mount,panelHtml,update:guarded(update),paletteItems:()=>{try{return paletteItems();}catch(error){log(error);return [];}},shapeIso3,dialogsEnabled:()=>ready()});
})(window,document);
