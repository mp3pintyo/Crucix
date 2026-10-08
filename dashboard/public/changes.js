(function(window,document){
  'use strict';
  // "What changed": the right-rail panel (panelHtml) and the header chip (chipHtml) over the `changes` object of a sweep snapshot
  // (lib/sweeps/changes.mjs) and over GET /api/changes?window=1h|6h|24h, which answers in the same shape merged over the archive.
  // Honesty rules: a merged window's totals are upper bounds ("up to"), the lists the server caps (records 40, transitions 30,
  // signals 20) say so, a null severity is the unknown dash, a state or level is always a glyph and a word, and a domain lens narrows
  // every list (items without a domain only show under `all`). The chosen window lives in memory only (a reload starts at the last sweep).
  // The panel is bounded: each list shows its first rows (SHOW) and a "Show all N" button (aria-expanded, a real <button>, so Enter/Space work)
  // opens it; which lists are open is kept in memory for the session and survives every re-render.
  // mount(options):
  //   t(key, fallback)   the page's text: group `changes`, plus `lenses.*`, `inspector.level.*`, `matrix.state*`
  //   locale, now()      BCP 47 tag of the since time, the page clock (frozen during a replay) for the age labels
  //   getChanges()       the snapshot's own changes object (the page's D.changes)
  //   panelShown()       whether the panel is in the user's layout (the chip is hidden when it is not)
  //   isReplay()         a sweep replay holds the page: the replayed snapshot's own changes are shown and the longer windows are off
  //   fetchJson(url)     reads the archive windows (without it only the last sweep is offered)
  //   openEvent(id)      a record row was chosen (the page opens it in the record inspector); without it rows are plain text
  //   openMatrix()       a source row was chosen (the page opens the health matrix); without it rows are plain text
  // update(changes) is called for every snapshot the page renders, refresh() rewrites the age labels in place.
  // Needs domains.js and lens-core.js (the lens) and record-core.js (the shared severity glyphs and age labels), all resolved when used.
  const WINDOWS=['last','1h','6h','24h'],WINDOW_KEY={last:'windowLast','1h':'window1h','6h':'window6h','24h':'window24h'};
  // The server's list caps (CHANGE_CAPS in lib/sweeps/changes.mjs; test/changes-ui.test.mjs keeps them equal).
  const CAPS={events:40,sources:30,signals:20};
  // How many rows each list shows until its "Show all" button is used (the expansion lives in memory for the session): the panel is the
  // first one of the right rail, so with every list at its cap it would otherwise be several screens tall.
  const SHOW={records:3,sources:3,signals:3};
  const EVENT_ID=/^event-[0-9a-f]{32}$/;
  const ISO_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  const LEVELS=['critical','high','watch','info'];
  const STATES={ok:'✓',stale:'◔',error:'✕',disabled:'–'},STATE_WORD={ok:'stateOk',stale:'stateStale',error:'stateError',disabled:'stateDisabled',nodata:'stateNoData'};
  const STATE_COPY={stateOk:'OK',stateStale:'Stale',stateError:'Error',stateDisabled:'Disabled',stateNoData:'No data'};
  const TYPES={new:['+','typeNew'],escalated:['▲','typeEscalated'],deescalated:['▼','typeDeescalated']};
  const COPY={title:'What changed',windowLabel:'Time window',windowLast:'Last sweep',window1h:'1 h',window6h:'6 h',window24h:'24 h',since:'Since {time}',byDomain:'Changes by domain',
    newRecords:'New records',sourceChanges:'Source changes',signals:'Signals',typeNew:'New',typeEscalated:'Escalated',typeDeescalated:'De-escalated',to:'changed to',upTo:'up to {count}',
    baseline:'First sweep, nothing to compare yet. Changes show up after the next sweep.',baselineWindow:'No earlier sweeps to compare in this window yet.',
    waiting:'Changes appear once the first sweep has finished.',nothing:'Nothing changed since the previous sweep.',nothingWindow:'Nothing changed in this window.',nothingLens:'Nothing changed in this domain.',
    loading:'Loading changes…',error:'Could not load the {window} changes. Showing {shown} instead.',errorStale:'Could not refresh the {window} changes. The earlier data is shown.',
    replayNote:'Longer windows read the live archive, so they are off during the replay. The list is the replayed sweep’s own.',
    cappedRecords:'Showing {shown} of {total} new records, most severe first.',cappedRecordsAbout:'Showing {shown} of up to {total} new records, most severe first.',
    cappedList:'Showing {shown}. The list is capped, so more may exist.',showAll:'Show all {count}',showFewer:'Show fewer',chipLabel:'{count} changes since the previous sweep',chipLabelOne:'{count} change since the previous sweep',
    chipLabelAtLeast:'At least {count} changes since the previous sweep'};
  let opts=null,selected='last',shown=null,loading=false,failed='',seq=0,key='',lastMarkup='';
  const expanded={records:false,sources:false,signals:false};
  const log=error=>{try{console.error('[changes]',error);}catch{}};
  const guarded=fn=>(...args)=>{try{return fn(...args);}catch(error){log(error);}};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  // Plain text; escaped only where it goes into markup.
  function tx(path,fallback){try{const value=opts&&typeof opts.t==='function'?opts.t(path,fallback):fallback;return typeof value==='string'&&value?value:fallback;}catch{return fallback;}}
  function say(name,values){let text=tx('changes.'+name,COPY[name]);for(const [from,to] of Object.entries(values||{}))text=text.split('{'+from+'}').join(String(to));return text;}
  const windowText=id=>say(WINDOW_KEY[id]);
  const inReplay=()=>{try{return !!(opts&&typeof opts.isReplay==='function'&&opts.isReplay());}catch{return false;}};

  // ===== Times =====
  const isoMs=value=>{const ms=typeof value==='string'&&ISO_TIME.test(value)?Date.parse(value):NaN;return Number.isFinite(ms)?ms:null;};
  const nowMs=()=>{try{const value=opts&&typeof opts.now==='function'?opts.now():NaN;return Number.isFinite(value)?value:Date.now();}catch{return Date.now();}};
  const ageOf=ms=>{const R=window.CrucixRecords;return ms!==null&&R&&typeof R.ageLabel==='function'?R.ageLabel(ms,nowMs()):'—';};
  const stamp=ms=>new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC';
  function clock(ms){
    try{return new Date(ms).toLocaleString(opts&&opts.locale||undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
    catch{return stamp(ms);}
  }

  // ===== Lens =====
  const domainIds=()=>{const domains=window.CrucixDomains;return domains&&Array.isArray(domains.DOMAIN_IDS)?domains.DOMAIN_IDS:[];};
  const core=()=>window.CrucixLensCore;
  const lensOf=lens=>{const lensCore=core();return lensCore&&typeof lensCore.normalize==='function'?lensCore.normalize(lens):'all';};
  function currentLens(){try{return window.CrucixLens&&typeof window.CrucixLens.get==='function'?window.CrucixLens.get():'all';}catch{return 'all';}}
  // Items name their source as a bare string (records, transitions); one without a known source has no domain and only shows under `all`.
  const matches=(lens,item)=>lens==='all'||(!!core()&&core().matchesEvent(lens,item));
  const domainCount=(domains,id)=>Object.hasOwn(domains,id)?count(domains[id]):0;

  // ===== The object =====
  // The lists are read only up to the server's caps. null when `changes` is not an object (no snapshot yet, or a startup snapshot).
  function read(changes){
    if(!isObject(changes))return null;
    const events=isObject(changes.events)?changes.events:{},items=(value,cap)=>Array.isArray(value)?value.filter(isObject).slice(0,cap):[];
    return {since:isoMs(changes.since),baseline:changes.baseline===true,records:items(events.new,CAPS.events),newTotal:count(events.newTotal),sources:items(changes.sources,CAPS.sources),signals:items(changes.signals,CAPS.signals),domains:isObject(changes.domains)?changes.domains:{}};
  }
  // The figures of one object under a lens. `total` is the number of new records (known = the list does not hide how many there are in
  // this lens); `sum` is every change counted once, `atLeast` that a capped list may hide more of them.
  function tally(data,lens){
    const records=data.records.filter(item=>matches(lens,item)),sources=data.sources.filter(item=>matches(lens,item)),signals=lens==='all'?data.signals:[];
    const sourcesCapped=data.sources.length>=CAPS.sources,signalsCapped=data.signals.length>=CAPS.signals;
    if(lens==='all'){
      const total=Math.max(data.newTotal,records.length);
      return {records,sources,signals,total,known:true,sum:total+sources.length+signals.length,atLeast:sourcesCapped||signalsCapped,sourcesCapped,signalsCapped};
    }
    // domains counts the new records and the transitions of a domain (both uncapped), so the records alone are known only while the
    // transition list is complete.
    const domain=domainCount(data.domains,lens),known=!sourcesCapped;
    return {records,sources,signals,total:known?Math.max(domain-sources.length,records.length):records.length,known,sum:Math.max(domain,records.length+sources.length),atLeast:false,sourcesCapped,signalsCapped};
  }
  // A figure that may be an upper bound: spoken as "up to N", shown as "≤N".
  const figure=(number,exact)=>exact?String(number):`<span aria-hidden="true">≤${number}</span><span class="ch-sr">${esc(say('upTo',{count:number}))}</span>`;

  // ===== Markup =====
  // The shared severity glyphs of record-core.js (the word beside it carries the meaning when that file is missing).
  const glyphOf=level=>{const R=window.CrucixRecords;return R&&R.GLYPH&&R.GLYPH[level]||'';};
  function severity(value){
    const level=LEVELS.includes(value)?value:'unknown';
    return `<span class="ch-sev sev-${level}"><i aria-hidden="true">${esc(glyphOf(level))}</i> ${esc(tx('inspector.level.'+level,level[0].toUpperCase()+level.slice(1)))}</span>`;
  }
  function stateTag(value){
    const state=typeof value==='string'&&Object.hasOwn(STATES,value)?value:'nodata',word=STATE_WORD[state];
    return `<span class="ch-state" data-state="${state}"><i aria-hidden="true">${esc(STATES[state]||'·')}</i> ${esc(tx('matrix.'+word,STATE_COPY[word]))}</span>`;
  }
  function recordRow(item){
    const id=typeof item.id==='string'&&EVENT_ID.test(item.id)?item.id:null,ms=isoMs(item.observedAt);
    const from=typeof item.source==='string'&&item.source?`<span class="ch-source">${esc(item.source)}</span>`:'';
    const age=`<span class="ch-age"${ms===null?'':` data-changes-time="${esc(new Date(ms).toISOString())}" title="${esc(stamp(ms))}"`}>${esc(ageOf(ms))}</span>`;
    const inner=`${severity(item.severity)}<span class="ch-title">${esc(typeof item.title==='string'&&item.title?item.title:'—')}</span><span class="ch-meta">${from}${age}</span>`;
    return `<li class="ch-item">${id&&opts&&typeof opts.openEvent==='function'?`<button type="button" class="ch-row" id="changes-ev-${esc(id)}" data-changes-event="${esc(id)}">${inner}</button>`:`<div class="ch-row">${inner}</div>`}</li>`;
  }
  function sourceRow(item){
    const name=item.source,inner=`<span class="ch-name">${esc(name)}</span><span class="ch-trans">${stateTag(item.from)}<span class="ch-arrow" aria-hidden="true">→</span><span class="ch-sr">${esc(say('to'))}</span>${stateTag(item.to)}</span>`;
    return `<li class="ch-item">${opts&&typeof opts.openMatrix==='function'?`<button type="button" class="ch-row ch-src" data-changes-source="${esc(name)}">${inner}</button>`:`<div class="ch-row ch-src">${inner}</div>`}</li>`;
  }
  // The delta engine's labels are English constants (the archive keeps them too): shown in the page language by the signal key
  // (delta.labels.* / delta.reasons.*), the stored label being the fallback. A source_degradation label carries its numbers only in the
  // stored sentence, so it stays as stored.
  function signalText(name,type,stored){
    if(name.startsWith('tg_urgent:'))return tx('delta.reasons.tg_urgent',stored);
    if(!/^[a-z0-9_]{1,40}$/.test(name)||name==='source_degradation')return stored;
    return tx(type==='new'&&name==='nuke_anomaly'?'delta.reasons.nuke_anomaly':'delta.labels.'+name,stored);
  }
  function signalRow(item){
    const name=typeof item.key==='string'?item.key:'',label=signalText(name,item.type,typeof item.label==='string'&&item.label?item.label:name),type=typeof item.type==='string'&&Object.hasOwn(TYPES,item.type)?TYPES[item.type]:null;
    const tag=type?`<span class="ch-meta"><span class="ch-type" data-type="${esc(item.type)}"><i aria-hidden="true">${type[0]}</i> ${esc(say(type[1]))}</span></span>`:'';
    return `<li class="ch-item ch-sig" data-signal="${esc(name)}"><div class="ch-row">${severity(item.severity)}<span class="ch-title">${esc(label)}</span>${tag}</div></li>`;
  }
  // One list: the first SHOW rows, or all of them once the section's button was used (a section with nothing more to show has no button).
  const section=(name,id,title,figureHtml,list,render,cap,open)=>{
    const more=list.length>SHOW[name]?`<button type="button" class="ch-more" data-changes-more="${name}" aria-expanded="${open}" aria-controls="${id}List">${esc(open?say('showFewer'):say('showAll',{count:list.length}))}</button>`:'';
    return `<section class="ch-sec" data-changes-section="${name}" aria-labelledby="${id}"><h4 id="${id}">${esc(title)} <span class="ch-n">${figureHtml}</span></h4><ul class="ch-list" id="${id}List">${list.slice(0,open?list.length:SHOW[name]).map(render).join('')}</ul>${cap||more?`<div class="ch-foot">${cap?`<p class="ch-cap">${esc(cap)}</p>`:''}${more}</div>`:''}</section>`;
  };
  function domainChips(data,lens,exact){
    const list=domainIds().filter(id=>(lens==='all'||id===lens)&&domainCount(data.domains,id)>0);
    if(!list.length)return '';
    return `<ul class="ch-domains" aria-label="${esc(say('byDomain'))}">${list.map(id=>`<li class="ch-dom" data-domain="${esc(id)}"><span class="ch-dom-name">${esc(tx('lenses.'+id,id))}</span> <span class="ch-dom-n">${figure(domainCount(data.domains,id),exact)}</span></li>`).join('')}</ul>`;
  }
  const calm=(state,text)=>`<p class="ch-note ch-calm" data-changes-state="${state}">${esc(text)}</p>`;
  function sinceLine(ms){
    const parts=say('since',{time:'{time}'}).split('{time}');
    return `<p class="ch-since">${esc(parts[0])}<time datetime="${esc(new Date(ms).toISOString())}">${esc(clock(ms))}</time>${esc(parts.slice(1).join(''))}</p>`;
  }

  // The sections of one object under a lens; merged = a window answer, whose totals are upper bounds (the snapshot's own are real counts).
  function body(data,lens,merged,open){
    const exact=!merged;
    if(data.baseline){const name=merged?'baselineWindow':'baseline';return calm(name,say(name));}
    const t=tally(data,lens);
    if(t.sum<1){
      const any=data.newTotal>0||data.records.length>0||data.sources.length>0||data.signals.length>0,name=any&&lens!=='all'?'nothingLens':merged?'nothingWindow':'nothing';
      return calm(name,say(name));
    }
    let out=domainChips(data,lens,exact);
    const listed=t.records.length,total=t.known?t.total:listed,exactTotal=exact||total===listed;
    // The notes count the rows on screen: the first SHOW ones until the section is opened.
    const rows=name=>open(name)?Infinity:SHOW[name];
    if(listed>0||total>0){
      const onScreen=Math.min(listed,rows('records'));
      let cap='';
      if(!t.known&&data.records.length>=CAPS.events)cap=say('cappedList',{shown:onScreen});
      else if(total>onScreen)cap=say(exactTotal?'cappedRecords':'cappedRecordsAbout',{shown:onScreen,total});
      out+=section('records','changesRecords',say('newRecords'),figure(total,exactTotal),t.records,recordRow,cap,open('records'));
    }
    const names=t.sources.filter(item=>typeof item.source==='string'&&item.source);
    if(names.length)out+=section('sources','changesSources',say('sourceChanges'),String(names.length),names,sourceRow,t.sourcesCapped?say('cappedList',{shown:Math.min(names.length,rows('sources'))}):'',open('sources'));
    if(t.signals.length)out+=section('signals','changesSignals',say('signals'),String(t.signals.length),t.signals,signalRow,t.signalsCapped?say('cappedList',{shown:Math.min(t.signals.length,rows('signals'))}):'',open('signals'));
    return out;
  }

  // options (tests and callers that know better than the module's state): lens, window, windowChanges, replay, loading, failed, expanded.
  function build(changes,options){
    const o=isObject(options)?options:{};
    const replay=typeof o.replay==='boolean'?o.replay:inReplay();
    const lens=lensOf(o.lens!==undefined?o.lens:currentLens());
    const win=WINDOWS.includes(o.window)?o.window:replay?'last':selected;
    const answer=o.windowChanges!==undefined?o.windowChanges:shown&&shown.window===win?shown.changes:undefined;
    // A window that has not answered yet shows what is already on screen: the last good answer, else the snapshot's own object.
    const stale=win!=='last'&&answer===undefined;
    const content=win==='last'?changes:answer!==undefined?answer:shown?shown.changes:changes;
    const merged=win!=='last'&&!(stale&&!shown);
    const busy=typeof o.loading==='boolean'?o.loading:loading&&!replay,problem=typeof o.failed==='string'?o.failed:replay?'':failed;
    const windows=opts&&typeof opts.fetchJson==='function',open=name=>isObject(o.expanded)&&typeof o.expanded[name]==='boolean'?o.expanded[name]:expanded[name]===true;
    const data=read(content);
    const buttons=windows?`<div class="ch-windows" role="group" aria-label="${esc(say('windowLabel'))}">${WINDOWS.map(id=>`<button type="button" class="ch-win" data-changes-window="${id}" aria-pressed="${id===win}"${replay&&id!=='last'?' aria-disabled="true" aria-describedby="changesNote"':''}>${esc(windowText(id))}</button>`).join('')}</div>`:'';
    const status=busy?`<p class="ch-status" role="status">${esc(say('loading'))}</p>`:WINDOWS.includes(problem)?`<p class="ch-status ch-error" role="status">${esc(problem===win?say('errorStale',{window:windowText(problem)}):say('error',{window:windowText(problem),shown:windowText(win)}))}</p>`:'';
    const note=replay&&windows?`<p class="ch-note ch-replay" id="changesNote">${esc(say('replayNote'))}</p>`:'';
    let badge='',since='',main;
    if(!data)main=calm('waiting',say('waiting'));
    else{
      const t=data.baseline?null:tally(data,lens);
      // A merged window mixes an upper bound with capped lists: no single honest figure, so only the snapshot's own object gets a badge.
      if(t&&t.sum>0&&!merged)badge=`<span class="badge">${t.sum}${t.atLeast?'+':''}</span>`;
      if(!data.baseline&&data.since!==null)since=sinceLine(data.since);
      main=body(data,lens,merged,open);
    }
    return `<div class="g-panel changes-panel" id="changesPanel" role="region" aria-labelledby="changesTitle" data-window="${win}"${busy?' aria-busy="true"':''}${stale&&busy?' data-stale="true"':''}><div class="sec-head"><h3 id="changesTitle" tabindex="-1">${esc(say('title'))}</h3>${badge}</div>${buttons}${since}${status}${note}${main}</div>`;
  }
  function panelHtml(changes,options){
    try{lastMarkup=build(changes,options);return lastMarkup;}
    catch(error){log(error);return '';}
  }
  // The header chip "Δ N": new records + transitions + signals of the snapshot's own object under the lens (always the last sweep,
  // whichever window the panel shows). Empty at zero, on a baseline, without an object and while the panel is not in the layout.
  function chipHtml(changes,lens){
    try{
      if(!opts||(typeof opts.panelShown==='function'&&!opts.panelShown()))return '';
      const data=read(changes);
      if(!data||data.baseline)return '';
      const active=lensOf(lens!==undefined?lens:currentLens()),t=tally(data,active);
      if(t.sum<1)return '';
      let text=say(t.atLeast?'chipLabelAtLeast':t.sum===1?'chipLabelOne':'chipLabel',{count:t.sum});
      if(active!=='all')text+=' ('+tx('lenses.status','Domain lens: {name}').split('{name}').join(tx('lenses.'+active,active))+')';
      return `<button type="button" class="guide-btn ch-chip" id="changesChip" data-changes-chip aria-label="${esc(text)}" title="${esc(text)}"><span class="ch-delta" aria-hidden="true">Δ</span> <span class="ch-n">${t.sum}${t.atLeast?'+':''}</span></button>`;
    }catch(error){log(error);return '';}
  }

  // ===== Windows =====
  // The page rebuilds the rails with innerHTML on every update; a change of state here swaps the panel in place and keeps the focus.
  const FOCUS_ATTRS=['data-changes-window','data-changes-more','data-changes-event','data-changes-source'];
  function mark(node){
    if(node.id==='changesTitle')return {title:true};
    for(const attr of FOCUS_ATTRS){const value=typeof node.getAttribute==='function'?node.getAttribute(attr):null;if(typeof value==='string')return {attr,value};}
    return null;
  }
  function restore(spot){
    const panel=document.getElementById('changesPanel');
    if(!panel)return;
    const target=spot.title?panel.querySelector('#changesTitle'):[...panel.querySelectorAll('['+spot.attr+']')].find(node=>node.getAttribute(spot.attr)===spot.value);
    if(target&&typeof target.focus==='function')target.focus({preventScroll:true});
  }
  function redraw(){
    if(!opts)return;
    const node=document.getElementById('changesPanel');
    if(!node)return;
    let markup;
    try{markup=build(typeof opts.getChanges==='function'?opts.getChanges():undefined);}catch(error){log(error);return;}
    if(markup===lastMarkup)return;
    const active=document.activeElement,spot=active&&typeof node.contains==='function'&&node.contains(active)?mark(active):null;
    lastMarkup=markup;node.outerHTML=markup;
    if(spot)restore(spot);
  }
  // `mine` is the request's sequence number: another choice, "last" or a newer sweep since makes this answer stale.
  function start(win){
    const mine=++seq;
    loading=true;failed='';
    let request;
    try{request=Promise.resolve(opts.fetchJson('/api/changes?window='+win));}catch(error){request=Promise.reject(error);}
    // A failed or malformed answer: the last good content stays and the pressed button goes back to what is shown; the next choice asks again.
    const fail=()=>{loading=false;failed=win;selected=shown?shown.window:'last';};
    request.then(data=>{
      if(mine!==seq)return;
      if(isObject(data)&&isObject(data.events)){shown={window:win,changes:data};loading=false;failed='';}else fail();
      redraw();
    },()=>{
      if(mine!==seq)return;
      fail();redraw();
    }).catch(log);
  }
  function select(win){
    if(!opts||!WINDOWS.includes(win)||typeof opts.fetchJson!=='function'||inReplay())return;
    if(win===selected){if(failed){failed='';redraw();}return;}
    selected=win;failed='';
    // "Last sweep" forgets the window answer, so a later failing window never falls back to a stale one.
    if(win==='last'){seq++;loading=false;shown=null;}else start(win);
    redraw();
  }
  // A section's "Show all" / "Show fewer" button; the choice is kept for the session.
  function toggle(name){
    expanded[name]=!expanded[name];
    redraw();
  }
  // A new sweep: a chosen merged window is read again (the page renders the panel right after, so no redraw here).
  function update(changes){
    if(!opts)return;
    const next=isObject(changes)&&typeof changes.at==='string'?changes.at:'';
    if(next===''||next===key)return;
    key=next;
    if(selected!=='last'&&typeof opts.fetchJson==='function'&&!inReplay())start(selected);
  }
  // The age labels move with the clock; the nodes stay (so does the focus).
  function refresh(){
    try{
      const panel=document.getElementById('changesPanel');
      if(!panel)return;
      for(const node of panel.querySelectorAll('[data-changes-time]')){
        const label=ageOf(isoMs(node.getAttribute('data-changes-time')));
        if(node.textContent!==label)node.textContent=label;
      }
    }catch(error){log(error);}
  }

  // ===== Events =====
  function focusPanel(){
    const panel=document.getElementById('changesPanel');
    if(!panel)return false;
    const reduced=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches),heading=panel.querySelector('#changesTitle')||panel.querySelector('button');
    if(typeof panel.scrollIntoView==='function')panel.scrollIntoView({block:'start',behavior:reduced?'auto':'smooth'});
    if(heading&&typeof heading.focus==='function')heading.focus({preventScroll:true});
    return true;
  }
  function onClick(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target:null;
    if(!target||!opts)return;
    if(target.closest('[data-changes-chip]')){focusPanel();return;}
    const more=target.closest('[data-changes-more]');
    if(more){toggle(more.getAttribute('data-changes-more'));return;}
    const windowButton=target.closest('[data-changes-window]');
    if(windowButton){select(windowButton.getAttribute('data-changes-window'));return;}
    const record=target.closest('[data-changes-event]');
    if(record){
      const id=record.getAttribute('data-changes-event');
      // A synchronous throw is caught by guarded() around this handler, a rejection here.
      if(typeof id==='string'&&EVENT_ID.test(id)&&typeof opts.openEvent==='function')Promise.resolve(opts.openEvent(id)).catch(log);
      return;
    }
    if(target.closest('[data-changes-source]')&&typeof opts.openMatrix==='function')Promise.resolve(opts.openMatrix()).catch(log);
  }
  function mount(options){
    if(opts||!options||typeof options!=='object')return false;
    opts=options;
    document.addEventListener('click',guarded(onClick));
    return true;
  }
  // focus(): the command palette's way to the panel (as the chip does); false while the panel is not on the page.
  window.CrucixChanges=Object.freeze({mount,panelHtml,chipHtml,update,refresh,focus:guarded(focusPanel)});
})(window,document);
