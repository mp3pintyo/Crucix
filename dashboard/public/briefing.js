(function(window,document){
  'use strict';
  // The cited briefing: a modal <dialog> with a scope selector (Global and the top countries of the snapshot's risk ranking, plus a preset
  // country), a Generate button and the answer of POST /api/briefing {scope} (lib/llm/briefing.mjs: {scope, generatedAt, language,
  // source: 'llm'|'rules', busy?: true, bullets:[{text, refs:[{n, id, title}]}]}). Every bullet keeps only its citations whose id is a real event id;
  // a bullet left without one is not shown (the server already drops those). A citation chip [n] opens the record in the inspector.
  // The answer is labelled "AI-generated from the cited records" or "Rule-based summary"; the model's text is plain text (escaped here).
  // mount(options):
  //   t(key, fallback), locale   the page's text (group `briefing`, `risk.replayNote`) and time locale
  //   getScopes()       [{iso3, name, displayName?}] of the scope list (the page's D.risk.top); displayName is shown when present
  //   postJson(url, body)  -> Promise<object>; a rejection may carry .status (default: fetch, same-origin, JSON, 120 s timeout)
  //   isReplay()        a sweep replay holds the page: the briefing reads the live store, so Generate is off and the note says why
  //   openEvent(id)     opens a record (default CrucixIntelligence.openEvent)
  // open(scope?) shows the dialog ('global' or an ISO3 code); the last answer of each scope stays in memory for the session.
  const ISO3=/^[A-Z]{3}$/,EVENT_ID=/^event-[0-9a-f]{32}$/,MAX_BULLETS=8,MAX_REFS=6,MAX_SCOPES=15;
  const ISO_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
  const COPY={title:'Briefing',close:'Close',scope:'Scope',global:'Global (last 24 hours)',generate:'Generate',intro:'Pick a scope and generate: every statement cites the records it is based on.',
    loading:'Generating the briefing… With an AI model this can take up to a minute.',error:'Could not generate the briefing. Try again.',errorStatus:'Could not generate the briefing (HTTP {status}). Try again.',
    sourceLlm:'AI-generated from the cited records',sourceRules:'Rule-based summary',rulesHelp:'No AI model gave a usable cited answer (or none is configured), so template sentences summarise the most significant records.',
    busy:'The AI model was busy with other briefings, so this is the rule-based summary. Generate again in a moment for an AI one.',
    checked:'Citations are checked against real records: a statement without a valid citation is dropped.',empty:'Nothing to summarise: no record in this scope.',generated:'Generated {time}',
    citations:'Sources',cite:'Open record {n}: {title}',paletteAction:'Country risk briefing'};
  let opts=null,nodes=null,seq=0,opener=null,finished=true,loading=false;
  const results=new Map();
  const log=error=>{try{console.error('[briefing]',error);}catch{}};
  const guarded=fn=>(...args)=>{try{return fn(...args);}catch(error){log(error);}};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  function tx(path,fallback){try{const value=opts&&typeof opts.t==='function'?opts.t(path,fallback):fallback;return typeof value==='string'&&value?value:fallback;}catch{return fallback;}}
  function fill(text,values){for(const [from,to] of Object.entries(values||{}))text=text.split('{'+from+'}').join(String(to));return text;}
  const say=(key,values)=>fill(tx('briefing.'+key,COPY[key]),values);
  const plain=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
  function replaying(){try{if(opts&&typeof opts.isReplay==='function')return !!opts.isReplay();const replay=window.CrucixReplay;return !!(replay&&typeof replay.active==='function'&&replay.active());}catch{return false;}}
  const replayNote=()=>tx('risk.replayNote','The country sheet and the briefing read the live store, so they are off during the replay. The ranking shown is the replayed sweep’s own.');
  const validScope=scope=>scope==='global'||(typeof scope==='string'&&ISO3.test(scope));
  function clock(ms){try{return new Date(ms).toLocaleString(opts&&opts.locale||undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC';}}

  // ===== The answer =====
  // The bullets as shown: text plus the citations with a valid row number and a real event id (at most 6); a bullet without one is dropped.
  function bulletsOf(result){
    return result.bullets.filter(isObject).slice(0,MAX_BULLETS).map(bullet=>({text:plain(bullet.text,400),refs:(Array.isArray(bullet.refs)?bullet.refs:[])
      .filter(ref=>isObject(ref)&&Number.isInteger(ref.n)&&ref.n>=1&&ref.n<=999&&typeof ref.id==='string'&&EVENT_ID.test(ref.id)).slice(0,MAX_REFS)})).filter(bullet=>bullet.text&&bullet.refs.length);
  }
  function chip(ref){
    const title=plain(ref.title,300)||ref.id;
    return `<button type="button" class="bf-ref" data-briefing-ref="${ref.id}" title="${esc(title)}" aria-label="${esc(say('cite',{n:ref.n,title}))}">[${ref.n}]</button>`;
  }
  /** The markup of one POST /api/briefing answer, or '' when it is not one (pure; every dynamic string escaped). */
  function render(result){
    if(!isObject(result)||!Array.isArray(result.bullets))return '';
    const llm=result.source==='llm',bullets=bulletsOf(result),at=typeof result.generatedAt==='string'&&ISO_TIME.test(result.generatedAt)?Date.parse(result.generatedAt):NaN;
    const label=`<p class="bf-source" data-source="${llm?'llm':'rules'}"><i aria-hidden="true">${llm?'✦':'≡'}</i> ${esc(say(llm?'sourceLlm':'sourceRules'))}</p>${llm?'':`<p class="bf-help">${esc(say(result.busy===true?'busy':'rulesHelp'))}</p>`}`;
    const list=bullets.length
      ?`<ol class="bf-list">${bullets.map(bullet=>`<li class="bf-item"><p class="bf-text">${esc(bullet.text)}</p><p class="bf-refs"><span class="bf-sr">${esc(say('citations'))}: </span>${bullet.refs.map(chip).join(' ')}</p></li>`).join('')}</ol>`
      :`<p class="bf-calm">${esc(say('empty'))}</p>`;
    return label+list+(Number.isFinite(at)?`<p class="bf-time">${esc(say('generated',{time:clock(at)}))}</p>`:'');
  }

  // ===== The dialog =====
  function element(tag,className,content){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
  function build(){
    const dialog=element('dialog','bf-dialog'),box=element('div','bf-box'),top=element('div','bf-top'),title=element('h2','bf-title',say('title'));
    dialog.id='briefing-dialog';dialog.setAttribute('aria-labelledby','bf-title');title.id='bf-title';
    const closeButton=element('button','bf-close',say('close'));closeButton.type='button';
    top.append(title,closeButton);
    const tools=element('div','bf-tools'),label=element('label','bf-label',say('scope')),select=element('select','bf-scope'),generate=element('button','bf-generate',say('generate'));
    select.id='bf-scope';label.setAttribute('for','bf-scope');generate.type='button';tools.append(label,select,generate);
    const intro=element('p','bf-intro',say('intro')),checked=element('p','bf-checked',say('checked'));
    const status=element('p','bf-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.id='bf-status';
    const body=element('div','bf-body');
    box.append(top,intro,tools,status,body,checked);dialog.append(box);
    let press={down:false,up:false};
    dialog.addEventListener('pointerdown',guarded(event=>{press={down:event.target===dialog,up:false};}));
    dialog.addEventListener('pointerup',guarded(event=>{press.up=event.target===dialog;}));
    dialog.addEventListener('click',guarded(event=>{const both=press.down&&press.up;press={down:false,up:false};if(event.target===dialog&&both)closeDialog();}));
    dialog.addEventListener('close',guarded(()=>finish(false)));
    closeButton.addEventListener('click',guarded(()=>closeDialog()));
    generate.addEventListener('click',guarded(()=>{generateNow().catch(log);}));
    select.addEventListener('change',guarded(()=>{seq++;loading=false;show(select.value);}));
    document.body.append(dialog);
    nodes={dialog,title,select,generate,status,body};
  }
  function scopes(){
    let list=[];
    try{list=typeof opts.getScopes==='function'?opts.getScopes():[];}catch(error){log(error);}
    return (Array.isArray(list)?list:[]).filter(item=>isObject(item)&&typeof item.iso3==='string'&&ISO3.test(item.iso3)).slice(0,MAX_SCOPES).map(item=>({iso3:item.iso3,name:plain(item.displayName,120)||plain(item.name,120)||item.iso3}));
  }
  function options(preset){
    const list=scopes();
    if(preset!=='global'&&!list.some(item=>item.iso3===preset))list.unshift({iso3:preset,name:preset});
    nodes.select.replaceChildren(...[{iso3:'global',name:say('global')},...list].map(item=>{const option=element('option',undefined,item.iso3==='global'?item.name:item.name+' ('+item.iso3+')');option.value=item.iso3;return option;}));
    nodes.select.value=preset;
  }
  // The last answer of a scope, or nothing yet.
  function show(scope){
    nodes.status.textContent='';
    nodes.body.innerHTML=results.has(scope)?render(results.get(scope)):'';
  }
  function setOff(off){
    if(off){nodes.generate.setAttribute('aria-disabled','true');nodes.generate.setAttribute('aria-describedby','bf-status');nodes.select.disabled=true;}
    else{nodes.generate.removeAttribute('aria-disabled');nodes.generate.removeAttribute('aria-describedby');nodes.select.disabled=false;}
  }
  function open(scope){
    if(!opts)return false;
    const preset=validScope(scope)?scope:'global';
    if(!nodes)build();
    seq++;loading=false;nodes.body.removeAttribute('aria-busy');
    options(preset);
    if(!nodes.dialog.open){opener=document.activeElement||null;finished=false;nodes.dialog.showModal();}
    if(replaying()){setOff(true);nodes.body.innerHTML='';nodes.status.textContent=replayNote();return false;}
    setOff(false);show(preset);
    return true;
  }
  async function defaultPost(url,body){
    const init={method:'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)};
    if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function')init.signal=AbortSignal.timeout(120000);
    const response=await window.fetch(url,init);
    if(!response.ok){const error=new Error('HTTP '+response.status);error.status=response.status;throw error;}
    return response.json();
  }
  // `mine` is the request's sequence number: another scope, another open or a close since makes this answer stale.
  async function generateNow(){
    if(!opts||!nodes||!nodes.dialog.open||loading||replaying()||nodes.generate.getAttribute('aria-disabled')==='true')return false;
    const scope=nodes.select.value;
    if(!validScope(scope))return false;
    const mine=++seq;
    loading=true;nodes.body.setAttribute('aria-busy','true');nodes.status.textContent=say('loading');
    let data,markup='';
    try{data=await (typeof opts.postJson==='function'?opts.postJson:defaultPost)('/api/briefing',{scope});markup=render(data);}
    catch(error){
      if(mine!==seq)return false;
      loading=false;nodes.body.removeAttribute('aria-busy');
      nodes.status.textContent=error&&Number.isInteger(error.status)?say('errorStatus',{status:error.status}):say('error');
      return false;
    }
    if(mine!==seq)return false;
    loading=false;nodes.body.removeAttribute('aria-busy');
    if(!markup){nodes.status.textContent=say('error');return false;}
    results.set(scope,data);nodes.status.textContent='';nodes.body.innerHTML=markup;
    return true;
  }
  const usable=node=>!!node&&node!==document.body&&node.isConnected!==false&&typeof node.focus==='function';
  function finish(skipFocus){
    if(finished||(nodes&&nodes.dialog.open))return;
    finished=true;seq++;loading=false;
    const from=opener;opener=null;
    if(!skipFocus&&usable(from))from.focus();
  }
  function closeDialog(options){
    if(!nodes||!nodes.dialog.open)return;
    nodes.dialog.close();
    finish(!!options&&options.focus===false);
  }
  // A citation chip: the dialog closes (the answer stays in memory for this scope) and the record opens in the inspector.
  function onClick(event){
    const target=event.target&&typeof event.target.closest==='function'?event.target.closest('[data-briefing-ref]'):null;
    if(!target||!opts)return;
    const id=target.getAttribute('data-briefing-ref');
    if(typeof id!=='string'||!EVENT_ID.test(id))return;
    closeDialog();
    const intelligence=window.CrucixIntelligence,fn=typeof opts.openEvent==='function'?opts.openEvent:intelligence&&intelligence.openEvent;
    if(typeof fn==='function')Promise.resolve(fn(id)).catch(log);
  }
  function mount(options){
    if(opts||!options||typeof options!=='object')return false;
    opts=options;
    document.addEventListener('click',guarded(onClick));
    return true;
  }
  window.CrucixBriefing=Object.freeze({mount,open:guarded(open),close:guarded(closeDialog),render,generate:()=>generateNow().catch(error=>{log(error);return false;})});
})(window,document);
