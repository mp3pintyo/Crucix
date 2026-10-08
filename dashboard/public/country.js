(function(window,document){
  'use strict';
  // The country sheet: a modal <dialog> over GET /api/countries/:iso3 (lib/intelligence/risk-routes.mjs): the score with its component
  // table (weight and availability: a missing component is left out of the score, not guessed), a sparkline with a text alternative, the
  // VIEWS forecast months (run id, attribution, licence), the INFORM baseline (release, attribution, licence), convergence, the recent
  // records (each opens in the record inspector) and the linked countries (each opens its own sheet here). mount(options):
  //   fetchJson(url)    -> Promise<object>; a rejection may carry .status (404 = not in the gazetteer)
  //   t(key, fallback), locale   the page's text (groups `country`, `risk`, `inspector.level.*`, `intelligence.kind_*`) and time locale
  //   isReplay()        a sweep replay holds the page: the sheet reads the live store, so it only says why it is off
  //   openEvent(id)     opens a record (default CrucixIntelligence.openEvent); openBriefing(scope) (default CrucixBriefing.open)
  //   now()             the page clock of the age labels
  // open(iso3) shows the dialog (one request at a time: a newer open or a close makes an older answer stale); close() closes it. Esc, the
  // Close button and the backdrop close it too, and the focus goes back to where it was before the dialog opened.
  const ISO3=/^[A-Z]{3}$/,EVENT_ID=/^event-[0-9a-f]{32}$/;
  const ISO_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  const LEVELS=['critical','high','watch','info'],COMPONENTS=['events','persistence','diversity','attention','forecast','baseline','advisory'];
  const COPY={title:'Country sheet',close:'Close',loading:'Loading the country sheet…',error:'Could not load the country sheet. Close and reopen it to try again.',notFound:'This country is not in the gazetteer.',
    noScore:'No risk score: no recorded event in the last 7 days and no forecast or baseline for this country.',score:'Risk score',outOf:'{score} of 100',change:'24 h change',coverage:'Coverage',
    updated:'Scored {time} · model v{version}',components:'Components',component:'Component',weight:'Weight',value:'Value (0–100)',status:'Data',available:'Available',missing:'Missing (left out)',
    c_events:'Events (24 h)',c_persistence:'Persistence (7 days)',c_diversity:'Diversity of event types',c_attention:'News attention',c_forecast:'Conflict forecast (VIEWS)',c_baseline:'Baseline risk (INFORM)',c_advisory:'Travel advisory (U.S.)',
    trend:'Trend',trendDaily:'Daily score, last {count} days: {values}',trendRecent:'Score in the last 48 hours: {values}',trendNone:'Not enough history for a trend yet.',
    convergence:'Convergence',convergenceOn:'{count} event types at high or above within 24 hours: {kinds}.',convergenceOff:'No convergence: fewer than 3 event types at high or above within 24 hours.',
    forecast:'Conflict forecast (VIEWS)',forecastNone:'No VIEWS forecast for this country.',month:'Month',probability:'Chance of ≥ 25 battle deaths',fatalities:'Expected battle deaths',monthUsed:'used in the score',run:'Run {run}',
    baseline:'Baseline risk (INFORM)',baselineNone:'No INFORM baseline for this country.',baselineValue:'INFORM Risk {score} of 10',release:'Release {release}, published {published}',license:'Licence: {license}',
    advisory:'Travel advisory (U.S. State Department)',advisoryNone:'No U.S. travel advisory for this country.',advisoryLevel:'Level {level} of 4',adv_1:'Exercise Normal Precautions',adv_2:'Exercise Increased Caution',adv_3:'Reconsider Travel',adv_4:'Do Not Travel',
    advisoryUpdated:'Last changed {date}',advisoryNote:'A risk reading for U.S. travellers written by one government; it is not a finding about the country and not European guidance.',advisoryOpen:'Open the advisory',
    actors:'Threat actor groups',actorsNone:'No threat actor group is attributed to this country in the MISP galaxy.',actorsCount:'{count} groups in the MISP galaxy; the {shown} with the most known aliases are shown.',
    actorsNote:'Attribution is the MISP community’s suspicion, not a proven finding, and many groups have no country at all.',aliases:'also known as {names}',
    events:'Recent records',eventsNone:'No recorded event linked to this country.',located:'Located',mentioned:'Mentioned',untitled:'Title unavailable',
    linked:'Linked countries',linkedNone:'No country shares records with this one in the last 7 days.',linkedCount:'{count} shared records',briefing:'Briefing for this country',
    paletteOpen:'Open country: {name}',paletteHint:'Risk score {score}',paletteHintNone:'Country sheet'};
  let opts=null,nodes=null,seq=0,opener=null,finished=true;
  const log=error=>{try{console.error('[country]',error);}catch{}};
  const guarded=fn=>(...args)=>{try{return fn(...args);}catch(error){log(error);}};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  // Plain text (textContent and DOM attributes); escaped only where it goes into markup.
  function tx(path,fallback){try{const value=opts&&typeof opts.t==='function'?opts.t(path,fallback):fallback;return typeof value==='string'&&value?value:fallback;}catch{return fallback;}}
  function fill(text,values){for(const [from,to] of Object.entries(values||{}))text=text.split('{'+from+'}').join(String(to));return text;}
  const say=(key,values)=>fill(tx('country.'+key,COPY[key]),values);
  const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
  function replaying(){try{if(opts&&typeof opts.isReplay==='function')return !!opts.isReplay();const replay=window.CrucixReplay;return !!(replay&&typeof replay.active==='function'&&replay.active());}catch{return false;}}
  const replayNote=()=>tx('risk.replayNote','The country sheet and the briefing read the live store, so they are off during the replay. The ranking shown is the replayed sweep’s own.');
  const isoMs=value=>{const ms=typeof value==='string'&&ISO_TIME.test(value)?Date.parse(value):NaN;return Number.isFinite(ms)?ms:null;};
  const nowMs=()=>{try{const value=opts&&typeof opts.now==='function'?opts.now():NaN;return Number.isFinite(value)?value:Date.now();}catch{return Date.now();}};
  function clock(ms){try{return new Date(ms).toLocaleString(opts&&opts.locale||undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC';}}
  function number(value,digits){try{return new Intl.NumberFormat(opts&&opts.locale||undefined,{maximumFractionDigits:digits}).format(value);}catch{return String(Math.round(value*10**digits)/10**digits);}}
  const kindName=kind=>tx('intelligence.kind_'+kind,kind);
  const percent=value=>finite(value)?Math.round(value*100)+'%':'—';

  // ===== The sheet =====
  function changeText(value){
    if(!finite(value))return tx('risk.changeNone','No history yet');
    const n=Math.round(value);
    return n>0?'▲ +'+n:n<0?'▼ -'+Math.abs(n):'– 0';
  }
  function components(list){
    const rows=(Array.isArray(list)?list:[]).filter(item=>isObject(item)&&COMPONENTS.includes(item.key));
    if(!rows.length)return '';
    const body=rows.map(item=>{
      const on=item.available===true&&finite(item.value);
      return `<tr data-available="${on}"><th scope="row">${esc(say('c_'+item.key))}</th><td>${finite(item.weight)?esc(percent(item.weight)):'—'}</td><td>${on?esc(String(Math.round(item.value))):'<span aria-hidden="true">—</span>'}</td><td><span class="cs-avail"><i aria-hidden="true">${on?'✓':'·'}</i> ${esc(say(on?'available':'missing'))}</span></td></tr>`;
    }).join('');
    return `<section class="cs-sec" aria-labelledby="cs-components"><h3 id="cs-components">${esc(say('components'))}</h3><div class="cs-scroll"><table class="cs-table"><thead><tr><th scope="col">${esc(say('component'))}</th><th scope="col">${esc(say('weight'))}</th><th scope="col">${esc(say('value'))}</th><th scope="col">${esc(say('status'))}</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }
  // The daily series (one point per UTC day) when it has two points, else the last 48 hours; the text alternative lists the values.
  function trend(series){
    const pick=(list,key)=>(Array.isArray(list)?list:[]).filter(point=>isObject(point)&&finite(point.score)&&typeof point[key]==='string').slice(-30);
    const daily=pick(series&&series.daily,'day'),recent=pick(series&&series.recent,'at'),useDaily=daily.length>=2,points=useDaily?daily:recent;
    let body;
    if(points.length<2)body=`<p class="cs-calm">${esc(say('trendNone'))}</p>`;
    else{
      const values=points.slice(-14).map(point=>(useDaily?point.day:clock(isoMs(point.at)??0))+': '+Math.round(point.score)).join(', ');
      const alt=useDaily?say('trendDaily',{count:points.length,values}):say('trendRecent',{values});
      const w=240,h=48,step=w/(points.length-1),xy=points.map((point,i)=>(i*step).toFixed(1)+','+(h-2-(Math.max(0,Math.min(100,point.score))/100)*(h-4)).toFixed(1)).join(' ');
      body=`<svg class="cs-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(alt)}"><title>${esc(alt)}</title><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline></svg><p class="cs-alt">${esc(alt)}</p>`;
    }
    return `<section class="cs-sec" aria-labelledby="cs-trend"><h3 id="cs-trend">${esc(say('trend'))}</h3>${body}</section>`;
  }
  function convergence(value){
    const kinds=isObject(value)&&Array.isArray(value.kinds)?value.kinds.filter(kind=>typeof kind==='string'&&kind).slice(0,12):[];
    const on=isObject(value)&&value.active===true&&kinds.length>0;
    return `<section class="cs-sec" aria-labelledby="cs-conv"><h3 id="cs-conv">${esc(say('convergence'))}</h3><p class="cs-conv" data-active="${on}">${on?'<i aria-hidden="true">◆</i> ':''}${esc(on?say('convergenceOn',{count:kinds.length,kinds:kinds.map(kindName).join(', ')}):say('convergenceOff'))}</p></section>`;
  }
  function forecast(value){
    let body;
    if(!isObject(value)||!Array.isArray(value.months))body=`<p class="cs-calm">${esc(say('forecastNone'))}</p>`;
    else{
      const months=value.months.filter(month=>isObject(month)&&Number.isInteger(month.year)&&Number.isInteger(month.month)).slice(0,12);
      const rows=months.map(month=>`<tr${month.monthId===value.monthUsed?' data-used="true"':''}><th scope="row">${month.year}-${String(month.month).padStart(2,'0')}${month.monthId===value.monthUsed?` <span class="cs-used">(${esc(say('monthUsed'))})</span>`:''}</th><td>${finite(month.probability)?esc(percent(month.probability)):'—'}</td><td>${finite(month.fatalities)?esc(number(month.fatalities,1)):'—'}</td></tr>`).join('');
      body=`${months.length?`<div class="cs-scroll"><table class="cs-table"><thead><tr><th scope="col">${esc(say('month'))}</th><th scope="col">${esc(say('probability'))}</th><th scope="col">${esc(say('fatalities'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`:''}`
        +`<p class="cs-cite">${text(value.run,80)?esc(say('run',{run:text(value.run,80)}))+'. ':''}${esc(text(value.attribution,400))}</p>${text(value.license,300)?`<p class="cs-cite">${esc(say('license',{license:text(value.license,300)}))}</p>`:''}`;
    }
    return `<section class="cs-sec" aria-labelledby="cs-forecast"><h3 id="cs-forecast">${esc(say('forecast'))}</h3>${body}</section>`;
  }
  function baseline(value){
    let body;
    if(!isObject(value)||!finite(value.score))body=`<p class="cs-calm">${esc(say('baselineNone'))}</p>`;
    else body=`<p class="cs-value">${esc(say('baselineValue',{score:number(value.score,1)}))}</p>${text(value.release,80)?`<p class="cs-cite">${esc(say('release',{release:text(value.release,80),published:text(value.published,40)||'—'}))}</p>`:''}<p class="cs-cite">${esc(text(value.attribution,400))}</p>${text(value.license,300)?`<p class="cs-cite">${esc(say('license',{license:text(value.license,300)}))}</p>`:''}`;
    return `<section class="cs-sec" aria-labelledby="cs-baseline"><h3 id="cs-baseline">${esc(say('baseline'))}</h3>${body}</section>`;
  }
  const ADVISORY_URL=/^https:\/\/travel\.state\.gov\/[A-Za-z0-9/._-]{1,300}$/,DAY=/^\d{4}-\d{2}-\d{2}$/;
  function advisory(value){
    let body;
    const level=isObject(value)&&Number.isInteger(value.level)&&value.level>=1&&value.level<=4?value.level:0;
    if(!level)body=`<p class="cs-calm">${esc(say('advisoryNone'))}</p>`;
    else{
      const day=typeof value.updated==='string'&&DAY.test(value.updated)?value.updated:'';
      const link=typeof value.url==='string'&&ADVISORY_URL.test(value.url)?value.url:'';
      body=`<p class="cs-value" data-level="${level}">${esc(say('advisoryLevel',{level}))} · ${esc(say('adv_'+level))}</p>${day?`<p class="cs-cite">${esc(say('advisoryUpdated',{date:day}))}</p>`:''}<p class="cs-cite">${esc(say('advisoryNote'))}</p>`
        +`${link?`<p class="cs-cite"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(say('advisoryOpen'))}</a></p>`:''}<p class="cs-cite">${esc(text(value.attribution,400))}</p>${text(value.license,300)?`<p class="cs-cite">${esc(say('license',{license:text(value.license,300)}))}</p>`:''}`;
    }
    return `<section class="cs-sec" aria-labelledby="cs-advisory"><h3 id="cs-advisory">${esc(say('advisory'))}</h3>${body}</section>`;
  }
  function actors(value){
    let body;
    const groups=isObject(value)&&Array.isArray(value.groups)?value.groups.slice(0,12).filter(isObject).filter(group=>text(group.name,60)):[];
    if(!groups.length)body=`<p class="cs-calm">${esc(say('actorsNone'))}</p>`;
    else{
      const items=groups.map(group=>{const names=(Array.isArray(group.aliases)?group.aliases:[]).slice(0,4).map(alias=>text(alias,40)).filter(Boolean);return `<li><strong>${esc(text(group.name,60))}</strong>${names.length?` <span class="cs-cite">${esc(say('aliases',{names:names.join(', ')}))}</span>`:''}</li>`;}).join('');
      body=`<p class="cs-cite">${esc(say('actorsCount',{count:finite(value.count)?value.count:groups.length,shown:groups.length}))}</p><ul class="cs-actors">${items}</ul><p class="cs-cite">${esc(say('actorsNote'))}</p><p class="cs-cite">${esc(text(value.attribution,400))}</p>${text(value.license,300)?`<p class="cs-cite">${esc(say('license',{license:text(value.license,300)}))}</p>`:''}`;
    }
    return `<section class="cs-sec" aria-labelledby="cs-actors"><h3 id="cs-actors">${esc(say('actors'))}</h3>${body}</section>`;
  }
  const glyphOf=level=>{const R=window.CrucixRecords;return R&&R.GLYPH&&R.GLYPH[level]||'';};
  function events(list){
    const rows=(Array.isArray(list)?list:[]).filter(isObject).slice(0,20).map(item=>{
      const level=LEVELS.includes(item.level)?item.level:'unknown',ms=isoMs(item.observedAt)??isoMs(item.firstSeen),R=window.CrucixRecords;
      const age=ms!==null&&R&&typeof R.ageLabel==='function'?R.ageLabel(ms,nowMs()):ms!==null?clock(ms):'';
      const meta=[typeof item.kind==='string'&&item.kind?kindName(item.kind.slice(0,40)):'',say(item.relation==='located'?'located':'mentioned'),age].filter(Boolean).join(' · ');
      const inner=`<span class="cs-sev sev-${level}"><i aria-hidden="true">${esc(glyphOf(level))}</i> ${esc(tx('inspector.level.'+level,level[0].toUpperCase()+level.slice(1)))}</span><span class="cs-ev-title">${esc(text(item.title,300)||say('untitled'))}</span><span class="cs-ev-meta">${esc(meta)}</span>`;
      const id=typeof item.id==='string'&&EVENT_ID.test(item.id)?item.id:null;
      return `<li>${id?`<button type="button" class="cs-ev" data-country-event="${id}">${inner}</button>`:`<div class="cs-ev">${inner}</div>`}</li>`;
    });
    return `<section class="cs-sec" aria-labelledby="cs-events"><h3 id="cs-events">${esc(say('events'))}</h3>${rows.length?`<ul class="cs-list">${rows.join('')}</ul>`:`<p class="cs-calm">${esc(say('eventsNone'))}</p>`}</section>`;
  }
  function linked(list){
    const rows=(Array.isArray(list)?list:[]).filter(item=>isObject(item)&&typeof item.iso3==='string'&&ISO3.test(item.iso3)).slice(0,8)
      .map(item=>`<li><button type="button" class="cs-link" data-country-open="${item.iso3}">${esc(text(item.name,120)||item.iso3)} <span class="cs-n">${esc(say('linkedCount',{count:Number.isSafeInteger(item.count)?item.count:0}))}</span></button></li>`);
    return `<section class="cs-sec" aria-labelledby="cs-linked"><h3 id="cs-linked">${esc(say('linked'))}</h3>${rows.length?`<ul class="cs-links">${rows.join('')}</ul>`:`<p class="cs-calm">${esc(say('linkedNone'))}</p>`}</section>`;
  }
  /** The sheet's markup for one /api/countries/:iso3 answer (pure; every dynamic string escaped). */
  function render(data){
    if(!isObject(data)||typeof data.iso3!=='string'||!ISO3.test(data.iso3))return '';
    const scored=finite(data.score),at=isoMs(data.at);
    const score=scored?Math.max(0,Math.min(100,Math.round(data.score))):null;
    const head=scored
      ?`<div class="cs-head"><p class="cs-score" data-band="${score>=70?'high':score>=40?'elevated':score>=10?'watch':'low'}"><span class="cs-label">${esc(say('score'))}</span> <strong>${esc(say('outOf',{score}))}</strong></p><span class="cs-bar" aria-hidden="true"><span class="cs-fill" style="width:${score}%"></span></span><dl class="cs-facts"><div><dt>${esc(say('change'))}</dt><dd>${esc(changeText(data.change24h))}</dd></div><div><dt>${esc(say('coverage'))}</dt><dd>${esc(percent(data.coverage))}</dd></div></dl>${at!==null?`<p class="cs-cite">${esc(say('updated',{time:clock(at),version:Number.isSafeInteger(data.version)?data.version:'?'}))}</p>`:''}</div>`
      :`<p class="cs-calm cs-noscore">${esc(say('noScore'))}</p>`;
    const brief=`<p class="cs-actions"><button type="button" class="cs-brief" data-country-briefing="${data.iso3}" aria-haspopup="dialog">${esc(say('briefing'))}</button></p>`;
    return head+(scored?components(data.components):'')+trend(data.series)+(scored?convergence(data.convergence):'')+forecast(data.forecast)+baseline(data.baseline)+advisory(data.advisory)+actors(data.actors)+events(data.events)+linked(data.linked)+brief;
  }

  // ===== The dialog =====
  function element(tag,className,content){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
  function build(){
    const dialog=element('dialog','cs-dialog'),box=element('div','cs-box'),top=element('div','cs-top'),title=element('h2','cs-title',say('title'));
    dialog.id='country-sheet';dialog.setAttribute('aria-labelledby','cs-title');title.id='cs-title';title.setAttribute('tabindex','-1');
    const closeButton=element('button','cs-close',say('close'));closeButton.type='button';
    top.append(title,closeButton);
    const status=element('p','cs-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const body=element('div','cs-body');
    box.append(top,status,body);dialog.append(box);
    // The backdrop closes only for a press and a release both on it (a text selection dragged out of the sheet ends on the dialog too).
    let press={down:false,up:false};
    dialog.addEventListener('pointerdown',guarded(event=>{press={down:event.target===dialog,up:false};}));
    dialog.addEventListener('pointerup',guarded(event=>{press.up=event.target===dialog;}));
    dialog.addEventListener('click',guarded(event=>{const both=press.down&&press.up;press={down:false,up:false};if(event.target===dialog&&both)closeDialog();}));
    dialog.addEventListener('close',guarded(()=>finish(false)));
    closeButton.addEventListener('click',guarded(()=>closeDialog()));
    body.addEventListener('click',guarded(chosen));
    document.body.append(dialog);
    nodes={dialog,title,status,body,closeButton};
  }
  function busy(on){nodes.body.setAttribute('aria-busy',String(on));nodes.status.textContent=on?say('loading'):'';}
  async function open(iso3){
    if(!opts||typeof iso3!=='string'||!ISO3.test(iso3))return false;
    const mine=++seq;
    if(!nodes)build();
    if(!nodes.dialog.open){opener=document.activeElement||null;finished=false;nodes.dialog.showModal();}
    // During a replay the sheet would mix the live store into an archived view: only the reason is shown.
    if(replaying()){nodes.title.textContent=say('title');nodes.body.innerHTML='';nodes.body.setAttribute('aria-busy','false');nodes.status.textContent=replayNote();nodes.dialog.setAttribute('data-replay','true');return false;}
    nodes.dialog.removeAttribute('data-replay');
    const moveFocus=nodes.body.contains(document.activeElement);
    nodes.title.textContent=say('title')+' · '+iso3;nodes.body.innerHTML='';busy(true);
    if(moveFocus)nodes.title.focus();
    let data;
    try{data=await opts.fetchJson('/api/countries/'+iso3);}
    catch(error){if(mine!==seq)return false;busy(false);nodes.status.textContent=say(error&&error.status===404?'notFound':'error');return false;}
    if(mine!==seq)return false;
    let markup='';
    try{markup=isObject(data)&&data.iso3===iso3?render(data):'';}catch(error){log(error);markup='';}
    busy(false);
    if(!markup){nodes.status.textContent=say('error');return false;}
    nodes.title.textContent=(text(data.name,120)||iso3)+' · '+iso3;
    nodes.body.innerHTML=markup;nodes.body.scrollTop=0;
    return true;
  }
  const usable=node=>!!node&&node!==document.body&&node.isConnected!==false&&typeof node.focus==='function';
  // Esc, the Close button, the backdrop and close() all end here (once): late answers are dropped and the focus goes back to the opener.
  function finish(skipFocus){
    if(finished||(nodes&&nodes.dialog.open))return;
    finished=true;seq++;
    const from=opener;opener=null;
    if(!skipFocus&&usable(from))from.focus();
  }
  function closeDialog(options){
    if(!nodes||!nodes.dialog.open)return;
    nodes.dialog.close();
    finish(!!options&&options.focus===false);
  }
  // A record opens in the inspector after the sheet closed (the inspector returns the focus to the sheet's opener); a linked country opens
  // its own sheet in place; the briefing button hands over to the briefing dialog with this country as its scope.
  function chosen(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target:null;
    if(!target)return;
    const record=target.closest('[data-country-event]');
    if(record){
      const id=record.getAttribute('data-country-event');
      if(typeof id!=='string'||!EVENT_ID.test(id))return;
      closeDialog();
      const intelligence=window.CrucixIntelligence,fn=typeof opts.openEvent==='function'?opts.openEvent:intelligence&&intelligence.openEvent;
      if(typeof fn==='function')Promise.resolve(fn(id)).catch(log);
      return;
    }
    const other=target.closest('[data-country-open]');
    if(other){const code=other.getAttribute('data-country-open');if(typeof code==='string'&&ISO3.test(code))open(code).catch(log);return;}
    const brief=target.closest('[data-country-briefing]');
    if(brief){
      const code=brief.getAttribute('data-country-briefing');
      if(typeof code!=='string'||!ISO3.test(code))return;
      closeDialog();
      const fn=typeof opts.openBriefing==='function'?opts.openBriefing:window.CrucixBriefing&&window.CrucixBriefing.open;
      if(typeof fn==='function')Promise.resolve(fn(code)).catch(log);
    }
  }
  function mount(options){
    if(opts||!options||typeof options!=='object'||typeof options.fetchJson!=='function')return false;
    opts=options;
    return true;
  }
  window.CrucixCountry=Object.freeze({mount,open:iso3=>open(iso3).catch(error=>{log(error);return false;}),close:guarded(closeDialog),render,mounted:()=>!!opts});
})(window,document);
