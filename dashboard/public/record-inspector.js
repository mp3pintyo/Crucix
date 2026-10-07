(function(window){
  'use strict';
  // Needs record-core.js (window.CrucixRecords) loaded first.
  const {LEVELS,GLYPH,esc,safeUrl,stamp,ageLabel}=window.CrucixRecords;

  // ===== Render =====
  // Pure HTML-string builders: no DOM access, every dynamic value escaped, links through safeUrl, times through stamp/ageLabel.
  // They show the records the view gives in the given order; the caller composes filterRecords/sortRecords first.
  // Filter controls carry data-ri-filter="window|search|sort"; ids are prefixed ri- in the inspector and rb- in the browser.
  const PAGE=25,CHIPS=LEVELS.filter(level=>level!=='unknown');
  const STATE_TEXT={ok:'Current',error:'Unavailable',stale:'Expired'};
  const WINDOW_OPTIONS=[[1,'window1h','1 h'],[6,'window6h','6 h'],[24,'window24h','24 h'],[0,'windowAll','All']];
  const SORT_OPTIONS=[['severity','sortSeverity','Severity'],['time','sortTime','Newest'],['title','sortTitle','Title']];
  const obj=value=>value&&typeof value==='object'?value:null;
  const text=value=>typeof value==='string'?value:'';
  const levelOf=rec=>LEVELS.includes(rec.level)?rec.level:'unknown';
  // Anything but ok/error (a missing or unknown state) is treated as expired, like CrucixLiveSources.state.
  const stateOf=source=>source.state==='ok'||source.state==='error'?source.state:'stale';
  const translator=t=>(key,fallback)=>esc(typeof t==='function'?t(key,fallback):fallback);
  const levelName=(tx,level)=>tx('inspector.level.'+level,level[0].toUpperCase()+level.slice(1));
  // Glyph and colour for the eye, the level name for screen readers: colour is never the only signal.
  const glyph=(tx,level)=>`<span class="ri-glyph sev-${level}" aria-hidden="true">${GLYPH[level]}</span><span class="ri-sr">${levelName(tx,level)}</span>`;
  const link=(url,label,cls='')=>{const href=safeUrl(url);return href?`<a${cls?` class="${cls}"`:''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`:label;};
  const place=rec=>[rec.place,rec.country].map(text).filter(Boolean).map(esc).join(', ');
  // The full-screen browser has no e key and Esc goes back to the panel: it gets its own hint.
  const keys=(tx,browser)=>`<p class="ri-keys">${browser?tx('inspector.keysBrowser','j/k move · Enter details · / search · Esc back to panel'):tx('inspector.keys','j/k move · Enter details · / search · e expand · Esc close')}</p>`;

  function sourceInfo(source,tx,now,tag,id){
    const state=stateOf(source),rights=[source.attribution,source.rights].map(text).filter(Boolean).map(esc).join(' ');
    const license=text(source.license)?link(source.licenseUrl,esc(source.license)):'';
    const age=`<span class="ri-age" title="${tx('liveSources.providerTime','Provider time')}: ${esc(stamp(source.observedAt))}">${esc(ageLabel(Date.parse(source.observedAt),now))}</span>`;
    return `<div class="ri-source"><${tag} class="ri-name"${id?` id="${id}"`:''}>${link(source.url,esc(source.name))}</${tag}><span class="ri-state ri-state-${state}">${tx('liveSources.'+state,STATE_TEXT[state])}</span>${age}</div>${rights||license?`<small class="ri-attr">${[rights,license].filter(Boolean).join(' · ')}</small>`:''}`;
  }
  // Error and expired sources show why and when they last succeeded, never rows.
  function reason(source,tx){
    const why=stateOf(source)==='error'?tx('liveSources.unavailable','Source unavailable'):tx('liveSources.expired','Provider data expired or its timestamp is unknown. Live records are hidden.');
    return `<div class="ri-reason"><p>${why}</p><p>${tx('inspector.lastSuccess','Last successful update')}: ${esc(stamp(source.observedAt))}</p></div>`;
  }
  function filterBar(filters,tx,id){
    const f=obj(filters)||{},levels=Array.isArray(f.levels)?f.levels:[],hours=Number.isFinite(f.windowHours)?f.windowHours:0,sort=text(f.sort)||'severity';
    const option=(value,selected,label)=>`<option value="${value}"${selected?' selected':''}>${label}</option>`;
    const chips=CHIPS.map(level=>`<button type="button" class="ri-chip" data-ri-level="${level}" aria-pressed="${levels.includes(level)}"><span class="ri-glyph sev-${level}" aria-hidden="true">${GLYPH[level]}</span>${levelName(tx,level)}</button>`).join('');
    const windows=WINDOW_OPTIONS.map(([value,key,fallback])=>option(value,value===hours,tx('inspector.'+key,fallback))).join('');
    const sorts=SORT_OPTIONS.map(([value,key,fallback])=>option(value,value===sort,tx('inspector.'+key,fallback))).join('');
    return `<div class="ri-filters"><div class="ri-chips" role="group" aria-label="${tx('inspector.severity','Severity')}">${chips}</div>`
      +`<label class="ri-field"><span>${tx('inspector.timeWindow','Time window')}</span><select id="${id}-window" data-ri-filter="window">${windows}</select></label>`
      +`<label class="ri-field ri-field-search"><span>${tx('inspector.search','Search records')}</span><input id="${id}-search" data-ri-filter="search" type="search" maxlength="80" autocomplete="off" value="${esc(text(f.text).slice(0,80))}"></label>`
      +`<label class="ri-field"><span>${tx('inspector.sort','Sort')}</span><select id="${id}-sort" data-ri-filter="sort">${sorts}</select></label></div>`;
  }
  function listPart(view,tx,now){
    const recs=(Array.isArray(view.records)?view.records:[]).filter(obj);
    const total=Number.isFinite(view.total)?view.total:recs.length,limit=Number.isFinite(view.limit)&&view.limit>0?view.limit:PAGE;
    const page=recs.slice(0,limit),key=obj(obj(view.selected)?.record)?.key,picked=key===undefined?-1:page.findIndex(rec=>rec.key===key);
    // Roving tabindex: the selected row, or the first one, is the single tab stop.
    const rows=page.map((rec,i)=>{const where=place(rec);return `<li class="ri-row" role="option" data-key="${esc(rec.key)}" aria-selected="${i===picked}" tabindex="${i===Math.max(picked,0)?0:-1}">${glyph(tx,levelOf(rec))}<span class="ri-text"><span class="ri-title">${esc(rec.title)}</span>${where?`<span class="ri-place">${where}</span>`:''}</span><span class="ri-age">${esc(ageLabel(rec.time,now))}</span></li>`;}).join('');
    const list=rows?`<ul class="ri-list" role="listbox" aria-label="${tx('inspector.title','Record inspector')}">${rows}</ul>`
      :`<p class="ri-empty">${total?tx('inspector.noMatch','No records match the filters'):tx('liveSources.noRecords','No current records in the watched scope')}</p>`;
    const more=recs.length>limit?`<button type="button" class="ri-more" data-ri-action="more">${tx('inspector.showMore','Show 25 more')}</button>`:'';
    return list+more+(total?`<p class="ri-count" role="status">${page.length} / ${total} ${tx('inspector.shown','shown')}</p>`:'');
  }
  // `outdated` comes from reconcileSelection; rec.current is not consulted.
  function detail(selected,tx){
    const rec=obj(obj(selected)?.record);
    if(!rec)return '<section class="ri-detail" hidden></section>';
    const outdated=selected.outdated===true,level=levelOf(rec),where=place(rec);
    const coords=Number.isFinite(rec.lat)&&Number.isFinite(rec.lon)?rec.lat.toFixed(3)+', '+rec.lon.toFixed(3):'';
    const times=[['providerTime','Provider time',rec.observedAt||rec.publishedAt],['forecastFor','Forecast for',rec.forecastAt],['startsAt','Starts at',rec.startsAt],['validUntil','Valid until',rec.validUntil]]
      .filter(([,,value])=>value).map(([key,fallback,value])=>`<dt>${tx('liveSources.'+key,fallback)}</dt><dd>${esc(stamp(value))}</dd>`).join('');
    const info=times+(text(rec.source)?`<dt>${tx('inspector.sourceLabel','Source')}</dt><dd>${esc(rec.source)}</dd>`:'')
      +(where||coords?`<dt>${tx('inspector.location','Location')}</dt><dd>${[where,coords].filter(Boolean).join(' · ')}</dd>`:'');
    const facts=(Array.isArray(rec.facts)?rec.facts:[]).filter(fact=>text(fact?.label)).slice(0,8)
      .map(fact=>`<dt>${tx('inspector.fact.'+fact.label,fact.label)}</dt><dd>${typeof fact.value==='boolean'?(fact.value?tx('inspector.yes','Yes'):tx('inspector.no','No')):esc(fact.value)}</dd>`).join('');
    // Pivot links (pivots.js, optional): entities found in the record with a few public lookup pages each; nothing is fetched until a click.
    const pivots=window.CrucixPivots&&typeof window.CrucixPivots.pivotsFor==='function'?window.CrucixPivots.pivotsFor(rec).map(entity=>`<li><span class="ri-pivot-value">${esc(entity.value)}</span> ${entity.links.map(item=>link(item.url,esc(item.name))).join(' · ')}</li>`).join(''):'';
    const original=safeUrl(rec.url)?`<p>${link(rec.url,tx('liveSources.original','Original source'),'ri-original')}</p>`:'';
    const details=text(rec.eventId)?`<button type="button" class="ri-details" data-ri-action="details" data-event-id="${esc(rec.eventId)}">${tx('inspector.details','Event details')}</button>`:'';
    return `<section class="ri-detail${outdated?' ri-outdated':''}"><h3 class="ri-detail-title">${glyph(tx,level)}<span>${esc(rec.title)}</span></h3>${outdated?`<span class="ri-badge">${tx('inspector.outdated','No longer current')}</span>`:''}`
      +`${text(rec.summary)?`<p class="ri-summary">${esc(rec.summary)}</p>`:''}${info?`<dl class="ri-meta">${info}</dl>`:''}`
      +`${facts?`<h4>${tx('inspector.facts','Facts')}</h4><dl class="ri-facts">${facts}</dl>`:''}${pivots?`<h4>${tx('inspector.pivots','Look up elsewhere')}</h4><ul class="ri-pivots">${pivots}</ul>`:''}${original}${details}</section>`;
  }
  // Waiting (no source yet, e.g. opened from the hash before data), a reason, or filters + list.
  function body(view,source,tx,now,id){
    if(!source&&view.all!==true)return `<p class="ri-empty">${tx('liveSources.waiting','Waiting for the first collection')}</p>`;
    if(source&&stateOf(source)!=='ok')return reason(source,tx);
    return filterBar(view.filters,tx,id)+listPart(view,tx,now);
  }

  // Inner HTML of <aside id="record-inspector">.
  function renderInspector(view,t,now){
    const v=obj(view)||{},tx=translator(t),source=obj(v.source);
    const head=source?sourceInfo(source,tx,now,'h2','ri-heading'):`<h2 class="ri-name" id="ri-heading">${tx('inspector.title','Record inspector')}</h2>`;
    const actions=`<div class="ri-actions"><button type="button" class="ri-icon" data-ri-action="expand" aria-label="${tx('inspector.expand','Expand to full screen')}" title="${tx('inspector.expand','Expand to full screen')}"><span aria-hidden="true">⤢</span></button><button type="button" class="ri-icon" data-ri-action="close" aria-label="${tx('inspector.close','Close')}" title="${tx('inspector.close','Close')}"><span aria-hidden="true">×</span></button></div>`;
    return `<header class="ri-head">${head}${actions}</header>${body({...v,all:false},source,tx,now,'ri')}${detail(v.selected,tx)}${keys(tx)}`;
  }
  // Inner HTML of <dialog id="record-browser">: sources | list | detail. `source` is null when `all`. view.lens (the active domain
  // lens, lens-core.js) hides the sources of other domains from the list; the one open stays, counts are unchanged.
  function renderBrowser(view,t,now){
    const v=obj(view)||{},tx=translator(t),all=v.all===true,source=all?null:obj(v.source),core=window.CrucixLensCore;
    const inLens=name=>!core||core.matchesSource(v.lens,name)||name===source?.name;
    const pick=(name,label,current)=>`<li><button type="button" class="rb-source" data-ri-source="${esc(name)}"${current?' aria-current="true"':''}>${label}</button></li>`;
    const badges=levels=>CHIPS.filter(level=>Number.isFinite(levels?.[level])&&levels[level]>0).map(level=>`<span class="sev sev-${level}"><i aria-hidden="true">${GLYPH[level]}</i>${levels[level]}<span class="ri-sr"> ${levelName(tx,level)}</span></span>`).join('');
    const sources=(Array.isArray(v.sources)?v.sources:[]).filter(item=>obj(item)&&text(item.name)&&inLens(item.name)).map(item=>{const state=stateOf(item);return pick(item.name,`<span class="rb-name">${esc(item.name)}</span><span class="rb-count">${Number.isFinite(item.count)?item.count:0}</span>${state==='ok'?'':`<span class="rb-state">${tx('liveSources.'+state,STATE_TEXT[state])}</span>`}${badges(obj(item.levels))}`,source?.name===item.name);}).join('');
    const head=`<header class="rb-head"><h2 id="rb-heading">${tx('inspector.browserTitle','Record browser')}</h2><div class="ri-actions"><button type="button" class="rb-collapse" data-ri-action="collapse">${tx('inspector.collapse','Back to panel')}</button><button type="button" class="ri-icon" data-ri-action="close" aria-label="${tx('inspector.close','Close')}" title="${tx('inspector.close','Close')}"><span aria-hidden="true">×</span></button></div></header>`;
    const nav=`<nav class="rb-sources" aria-label="${tx('inspector.sourceLabel','Source')}"><ul>${pick('all',`<span class="rb-name">${tx('inspector.allSources','All sources')}</span>`,all)}${sources}</ul></nav>`;
    return `${head}<div class="rb-cols">${nav}<div class="rb-list">${source?sourceInfo(source,tx,now,'h3',''):''}${body({...v,all},source,tx,now,'rb')}</div><div class="rb-detail">${detail(v.selected,tx)}</div></div>${keys(tx,true)}`;
  }
  // ===== End render =====

  // ===== Controller =====
  // Thin DOM layer: CrucixRecords.store is the single state, mirrored to location.hash (replaceState only, never storage).
  // The docked <aside> and the modal <dialog> are body children; the live panel is never re-rendered for selection state.
  const R=window.CrucixRecords,SCROLLERS=['.ri-list','.ri-detail','.rb-cols','.rb-sources','.rb-list','.rb-detail'];
  let opts={},aside=null,dialog=null,lastRec=null,home=null;
  const live=()=>window.CrucixLiveSources;
  const clock=()=>{const value=typeof opts.now==='function'?opts.now():NaN;return Number.isFinite(value)?value:Date.now();};
  const arrayOf=fn=>{try{const value=fn?.();return Array.isArray(value)?value:[];}catch{return [];}};
  const sources=()=>arrayOf(opts.getSources).filter(source=>obj(source)&&Object.hasOwn(live().policies,source.source));
  const set=state=>R.store.set(state);
  const card=name=>name?document.querySelector(`[data-open-records="${CSS.escape(name)}"]`):null;

  // Records of one live source (fresh rows only) or of every snapshot event (`all`).
  // 2.8.0 rows have no eventId: they are paired to their event by source + title + observedAt, so "Event details" still works.
  function recordsOf(name,now,events,byId){
    if(name==='all')return R.toRecords(events);
    const source=sources().find(item=>item.source===name);if(!source)return [];
    const rows=live().observations([source],now).map(row=>{if(row.eventId)return row;const event=R.eventForRow(row,byId,events);return event?{...row,eventId:event.id}:row;});
    return R.toRecords(rows,name);
  }
  const info=(source,now)=>source&&{...source,name:source.source,state:live().state(source,now)};
  // view.total is the count before filters; the selection survives as outdated while lastRec still matches its key.
  function view(state,now,browser){
    const events=arrayOf(opts.getEvents),byId=R.indexEvents(events),recs=recordsOf(state.source,now,events,byId),f=state.filters,picked=R.reconcileSelection(state.record,lastRec,recs);
    if(picked.record&&!picked.outdated)lastRec=picked.record;
    const out={source:info(sources().find(item=>item.source===state.source),now),all:state.source==='all',records:R.sortRecords(R.filterRecords(recs,f,now),f.sort),total:recs.length,filters:f,limit:state.limit,selected:picked.record?picked:null,lens:window.CrucixLens?.get?.()};
    if(browser)out.sources=sources().map(source=>{const rows=source.source===state.source?recs:recordsOf(source.source,now,events,byId);return {name:source.source,state:live().state(source,now),count:rows.length,levels:R.countByLevel(rows)};});
    return out;
  }

  // Re-render one container, keeping its scroll positions and the focused control (rows by key, controls by id or data attribute).
  function focusSelector(node){
    if(!node)return null;
    if(node.classList.contains('ri-row'))return `.ri-row[data-key="${CSS.escape(node.dataset.key||'')}"]`;
    if(node.id)return '#'+CSS.escape(node.id);
    const attr=['data-ri-action','data-ri-level','data-ri-source'].find(name=>node.hasAttribute(name));
    return attr?`[${attr}="${CSS.escape(node.getAttribute(attr))}"]`:null;
  }
  function paint(el,html){
    const active=el.contains(document.activeElement)?document.activeElement:null,selector=focusSelector(active),caret=active?.tagName==='INPUT'?active.selectionStart:null;
    const scroll=SCROLLERS.map(selector=>el.querySelector(selector)?.scrollTop||0);
    el.innerHTML=html;
    SCROLLERS.forEach((selector,i)=>{const node=el.querySelector(selector);if(node&&scroll[i])node.scrollTop=scroll[i];});
    if(!active)return;
    const target=(selector&&el.querySelector(selector))||el.querySelector('.ri-row[tabindex="0"]')||el.querySelector('[data-ri-action="close"]');
    target?.focus({preventScroll:true});
    if(caret!==null&&target?.tagName==='INPUT')try{target.setSelectionRange(caret,caret);}catch{}
  }
  // A closed state clears only a hash this controller wrote; any other hash is left alone.
  function writeHash(state){
    const hash=R.serializeHash(state),allowed=Object.keys(live().policies);
    if(hash===location.hash.replace(/^#/,'')||(!hash&&!R.parseHash(location.hash,allowed).source))return;
    try{history.replaceState(null,'',hash?'#'+hash:location.pathname+location.search);}catch{}
  }
  function fromHash(){
    const parsed=R.parseHash(location.hash,Object.keys(live().policies));
    if(!parsed.source)return R.closeAll();
    let state=R.openSource(R.closeAll(),parsed.source);
    if(parsed.filters)state=R.setFilters(state,parsed.filters);
    if(parsed.record)state=R.selectRecord(state,parsed.record);
    if(parsed.source!=='all')home=parsed.source;
    return parsed.browserOpen?R.openBrowser(state):state;
  }

  function render(){
    if(!aside)return;
    const state=R.store.get(),now=clock(),open=!!state.source,browser=open&&(state.browserOpen||state.source==='all');
    writeHash(state);
    for(const node of document.querySelectorAll('.live-source[data-live-source]'))if(open&&node.dataset.liveSource===state.source)node.setAttribute('data-selected','true');else node.removeAttribute('data-selected');
    if(!open)lastRec=null;
    const v=open?view(state,now,browser):null,t=opts.t;
    const wasHidden=aside.hidden;
    aside.hidden=!open||browser;aside.setAttribute('aria-hidden',String(aside.hidden));
    // The alert tray docks in the same place, above this panel: an inspector that opens closes it (a records card does the
    // same through openFrom). A tray that held the focus (a hash link followed from inside it) hands it to the inspector
    // instead of dropping it to the page; otherwise the focus stays where it is. A tray opened while the inspector is shown
    // stays on top, as asked.
    let held=false;
    if(wasHidden&&!aside.hidden){const tray=document.getElementById('alertTray');held=!!tray&&!tray.hidden&&tray.contains(document.activeElement);window.CrucixAlerts?.close?.({focus:false});}
    if(!aside.hidden){paint(aside,renderInspector(v,t,now));dock();if(held)focusIn(aside);}
    if(browser){paint(dialog,renderBrowser(v,t,now));if(!dialog.open)dialog.showModal();}
    else if(dialog.open)dialog.close();
  }
  // The docked panel starts below the dashboard top bar and the alert strip under it while they are on screen (the bar wraps to
  // several rows, both scroll away).
  function dock(){
    if(!aside||aside.hidden)return;
    const strip=document.getElementById('alertStrip'),bar=strip&&!strip.hidden?strip:document.getElementById('topbar');
    aside.style.setProperty('--ri-top',Math.max(0,Math.round(bar?.getBoundingClientRect().bottom||0))+'px');
  }
  const focusIn=el=>(el.querySelector('.ri-row[tabindex="0"]')||el.querySelector('[data-ri-action="close"]'))?.focus();
  function openFrom(name){
    const state=R.store.get();home=name;
    // The inspector takes the tray's place whether it was closed or already open (render only sees closed -> open).
    window.CrucixAlerts?.close?.({focus:false});
    if(state.source!==name){lastRec=null;set(R.openSource(state,name));}
    focusIn(aside);
  }
  function close(){
    const name=R.store.get().source;
    set(R.closeAll());
    card(name)?.focus();
  }
  // Back from the browser: to the inspector of the source, or (from `all`) of the last opened source, else closed.
  function collapse(){
    const state=R.store.get();
    if(state.source!=='all')set(R.closeBrowser(state));
    else if(home){lastRec=null;set(R.openSource(state,home));}
    else return close();
    aside.querySelector('[data-ri-action="expand"]')?.focus();
  }
  // The event detail overlay cannot sit above a modal dialog, so the browser collapses first.
  function details(id){
    if(!id)return;
    if(dialog.open)collapse();
    window.CrucixIntelligence?.openEvent(id);
  }
  // Select and focus a row, keeping it in view once the detail has taken its share of the panel.
  function select(key,root){
    if(!key)return;
    set(R.selectRecord(R.store.get(),key));
    const row=root.querySelector(`.ri-row[data-key="${CSS.escape(key)}"]`),list=row?.closest('.ri-list');
    if(!row)return;
    // Only the docked list scrolls itself; in the browser the column scrolls and focus() brings the row into view.
    if(!list||list.scrollHeight<=list.clientHeight)return row.focus();
    row.focus({preventScroll:true});
    const top=row.offsetTop-list.offsetTop,bottom=top+row.offsetHeight;
    if(top<list.scrollTop)list.scrollTop=top;else if(bottom>list.scrollTop+list.clientHeight)list.scrollTop=bottom-list.clientHeight;
  }

  function onClick(event){
    const node=event.target.closest?.('[data-ri-action],.ri-row,.ri-chip,[data-ri-source]');if(!node)return;
    const state=R.store.get(),root=event.currentTarget;
    // In the stacked (narrow) browser the detail sits below the list: bring it into view after a tap.
    if(node.classList.contains('ri-row')){
      select(node.dataset.key,root);
      const cols=root.querySelector('.rb-cols'),detail=root.querySelector('.rb-detail');
      if(cols&&detail&&getComputedStyle(cols).display==='block')cols.scrollTop+=detail.getBoundingClientRect().top-cols.getBoundingClientRect().top;
      return;
    }
    if(node.classList.contains('ri-chip')){const level=node.dataset.riLevel,levels=state.filters.levels;return set(R.setFilters(state,{levels:levels.includes(level)?levels.filter(item=>item!==level):[...levels,level]}));}
    if(node.hasAttribute('data-ri-source')){const name=node.dataset.riSource;if(name!=='all')home=name;lastRec=null;return set(R.openBrowser(R.openSource(state,name)));}
    const action=node.dataset.riAction;
    if(action==='close')close();
    else if(action==='expand')set(R.openBrowser(state));
    else if(action==='collapse')collapse();
    else if(action==='more')set(R.showMore(state));
    else if(action==='details')details(node.dataset.eventId);
  }
  // Selects commit on change, the search box on every input (not mid-composition).
  function onFilter(event){
    const node=event.target.closest?.('[data-ri-filter]'),kind=node?.dataset.riFilter;
    if(!node||event.isComposing||(kind==='search')!==(event.type==='input'))return;
    set(R.setFilters(R.store.get(),kind==='window'?{windowHours:Number(node.value)}:kind==='sort'?{sort:node.value}:{text:node.value}));
  }
  // Keys only act while focus is inside the inspector or the browser; form fields keep their typing.
  function onKey(event){
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey)return;
    const root=event.currentTarget,target=event.target,key=event.key,row=target.closest?.('.ri-row');
    if(key==='Escape'){event.preventDefault();return root===dialog?collapse():close();}
    if(target.matches?.('input,select,textarea'))return;
    const step=key==='j'||row&&key==='ArrowDown'?1:key==='k'||row&&key==='ArrowUp'?-1:0;
    if(step){
      event.preventDefault();
      const rows=[...root.querySelectorAll('.ri-row')],from=rows.indexOf(row||root.querySelector('.ri-row[aria-selected="true"]'));
      const next=rows[from<0?0:Math.min(rows.length-1,Math.max(0,from+step))];
      if(next)select(next.dataset.key,root);
    }
    else if(key==='Enter'&&row){event.preventDefault();if(row.getAttribute('aria-selected')!=='true')select(row.dataset.key,root);else details(root.querySelector('[data-ri-action="details"]')?.dataset.eventId);}
    else if(key==='/'){event.preventDefault();root.querySelector('[data-ri-filter="search"]')?.focus();}
    else if(key==='e'&&root===aside){event.preventDefault();set(R.openBrowser(R.store.get()));}
  }

  // Once, after the dashboard has its data accessors: getSources() -> live source rows, getEvents() -> snapshot events.
  function mount(options){
    if(aside||!window.CrucixRecords||!live())return;
    // A failing inspector must never stop the dashboard: mount runs before init(), refresh before the map and panels redraw.
    try{
      opts=obj(options)||{};
      aside=document.createElement('aside');aside.id='record-inspector';aside.hidden=true;aside.setAttribute('aria-hidden','true');aside.setAttribute('aria-labelledby','ri-heading');
      dialog=document.createElement('dialog');dialog.id='record-browser';dialog.setAttribute('aria-labelledby','rb-heading');
      document.body.append(aside,dialog);
      for(const el of [aside,dialog]){el.addEventListener('click',onClick);el.addEventListener('change',onFilter);el.addEventListener('input',onFilter);el.addEventListener('keydown',onKey);}
      // A dialog closed by the browser itself (e.g. a close request) collapses the state too; our own close() finds it already collapsed.
      dialog.addEventListener('close',()=>{const state=R.store.get();if(state.source&&(state.browserOpen||state.source==='all'))collapse();});
      document.addEventListener('click',event=>{const button=event.target.closest?.('[data-open-records]');if(button)openFrom(button.dataset.openRecords);});
      window.addEventListener('hashchange',()=>{lastRec=null;set(fromHash());});
      // The dashboard scrolls <body>, whose scroll events do not bubble: listen in the capture phase.
      // The top bar and the alert strip are filled (and re-wrap) after mount: follow their size as well as the scroll position.
      document.addEventListener('scroll',event=>{if(!aside.contains(event.target))dock();},{capture:true,passive:true});
      const bars=['topbar','alertStrip'].map(id=>document.getElementById(id)).filter(Boolean);
      if(bars.length&&typeof ResizeObserver==='function'){const observer=new ResizeObserver(dock);for(const bar of bars)observer.observe(bar);}else window.addEventListener('resize',dock);
      R.store.subscribe(render);
      set(fromHash());
    }catch(e){console.error('[inspector]',e);}
  }
  // After new data: re-render in place (scroll, focused row and selection kept); never reopens a closed view.
  function refresh(){try{if(aside&&R.store.get().source)render();}catch(e){console.error('[inspector]',e);}}
  // The command palette: a live source opens in the docked inspector like its card's button (also from the browser), 'all' opens
  // every record in the browser. false for a name that is not a live source, and before mount.
  function open(name){
    if(!aside||typeof name!=='string')return false;
    try{
      if(name==='all'){lastRec=null;set(R.openBrowser(R.openSource(R.store.get(),'all')));return true;}
      if(!Object.hasOwn(live().policies,name))return false;
      // The same source expanded in the browser docks again (its filters kept); openFrom opens any other one docked.
      const state=R.store.get();
      if(state.browserOpen&&state.source===name)set(R.closeBrowser(state));
      openFrom(name);
      return true;
    }catch(e){console.error('[inspector]',e);return false;}
  }
  // ===== End controller =====

  window.CrucixRecordInspector={renderInspector,renderBrowser,mount,refresh,open};
})(window);
