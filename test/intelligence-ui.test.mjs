import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A small DOM boundary for the dependency-free browser module. Real browser QA
// supplements these tests; this double deliberately refuses all HTML parsing.
class Element {
  constructor(tag, document) { this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.attributes={};this.listeners={};this.style={};this.dataset=new Proxy({}, {set:(target,key,value)=>{target[key]=String(value);this.attributes['data-'+String(key).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())]=String(value);return true}});this._text='';this.value='';this.disabled=false;this.hidden=false;this.inert=false; }
  set textContent(value) { this._text=String(value??'');for(const c of this.children)c.parentNode=null;this.children=[]; }
  get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML parsing is forbidden'); }
  get id() { return this.attributes.id||''; } set id(v) { this.setAttribute('id',v); }
  get className() { return this.attributes.class||''; } set className(v) { this.setAttribute('class',v); }
  get isConnected() { let p=this;while(p){if(p===this.ownerDocument.body)return true;p=p.parentNode}return false; }
  get classList() { return { contains:n=>this.className.split(/\s+/).includes(n),add:n=>this.className=[...new Set([...this.className.split(/\s+/),n])].join(' '),remove:n=>this.className=this.className.split(/\s+/).filter(x=>x!==n).join(' '),toggle:(n,on)=>{const set=new Set(this.className.split(/\s+/));const enable=on??!set.has(n);if(enable)set.add(n);else set.delete(n);this.className=[...set].join(' ');return enable} }; }
  setAttribute(k,v) { this.attributes[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v); }
  getAttribute(k) { return this.attributes[k]??null; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(c) { if(c.parentNode)c.parentNode.removeChild(c);this.children.push(c);c.parentNode=this;return c; }
  append(...nodes) { for(const c of nodes)this.appendChild(typeof c==='string'?this.ownerDocument.createTextNode(c):c); }
  removeChild(c) { this.children=this.children.filter(x=>x!==c);c.parentNode=null;return c; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) { this.textContent='';this.append(...nodes); }
  contains(c) { return c===this||this.children.some(x=>x.contains(c)); }
  addEventListener(k,fn) { (this.listeners[k]??=[]).push(fn); }
  removeEventListener(k,fn) { this.listeners[k]=(this.listeners[k]||[]).filter(x=>x!==fn); }
  dispatchEvent(e) { e.target??=this;e.currentTarget=this;for(const fn of this.listeners[e.type]||[])fn(e);if(e.bubbles&&!e.stopped)this.parentNode?.dispatchEvent(e);return !e.defaultPrevented; }
  click() { if(!this.disabled)this.dispatchEvent(event('click')); }
  focus() { this.ownerDocument.activeElement=this;this.ownerDocument.dispatchEvent(event('focusin',{target:this})); }
  matches(selector) { return selector.split(',').some(part=>{const s=part.trim();if(s.includes(' '))return false;let base=s;const attrs=[...base.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g)];base=base.replace(/\[[^\]]+\]/g,'');if(attrs.some(([,k,v])=>this.getAttribute(k)===null||(v!==undefined&&this.getAttribute(k)!==v)))return false;if(base.startsWith('#'))return this.id===base.slice(1);if(base.startsWith('.'))return this.classList.contains(base.slice(1));return !base||this.tagName.toLowerCase()===base.toLowerCase();}); }
  querySelectorAll(selector) { const nodes=[];const walk=e=>{for(const c of e.children){if(c.matches(selector))nodes.push(c);walk(c)}};walk(this);return nodes; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
  closest(selector) { for(let e=this;e;e=e.parentNode)if(e.matches(selector))return e;return null; }
  getBoundingClientRect() { return {width:100,height:20}; }
}
function event(type,values={}) { return {type,bubbles:true,defaultPrevented:false,...values,preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true}}; }
function harness({storage,fetch,historyEnabled=false,profilesEnabled=false,snapshot={events:[]},translations={}}={}) {
  const document={listeners:{},createElement(tag){return new Element(tag,this)},createTextNode(value){const e=new Element('#text',this);e.textContent=value;return e},getElementById(id){return this.body.id===id?this.body:this.body.querySelector('#'+id)},querySelector(s){return this.body.querySelector(s)},querySelectorAll(s){return this.body.querySelectorAll(s)},addEventListener(k,f){(this.listeners[k]??=[]).push(f)},removeEventListener(k,f){this.listeners[k]=(this.listeners[k]||[]).filter(x=>x!==f)},dispatchEvent(e){for(const f of this.listeners[e.type]||[])f(e)}};
  document.body=new Element('body',document);document.activeElement=document.body;
  const main=document.createElement('main');main.id='main';document.body.appendChild(main);
  const trigger=document.createElement('button');trigger.id='trigger';main.appendChild(trigger);trigger.focus();
  const existing=document.createElement('aside');existing.inert=true;document.body.appendChild(existing);
  const values=new Map();const saved=storage||{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v))};
  const applied=[];let layout={zones:{left:['sensorGrid','nuclearWatch','riskGauges','spaceWatch'],center1:['newsTicker'],center2:['macroMarkets'],center3:['tradeIdeas'],right:['crossSourceSignals','osintStream','signalCore','sourceHealth','internetOutages','healthAlerts','supplementalHealth','sweepDelta']},visibility:{newsTicker:true,tradeIdeas:true},fixed:{map:true,mapRegions:true}},layers={news:true,network:true},region='europe';
  const downloads=[],opened=[];
  const window={document,localStorage:saved,navigator:{onLine:true},location:{origin:'http://localhost:3199'},open:(url)=>{opened.push(url);return {print(){}}},setTimeout,clearTimeout,AbortController,URL,URLSearchParams,Blob,fetch:fetch||(async()=>({ok:true,json:async()=>({items:[],total:0,offset:0,limit:50,stats:{}})}))};
  const context=vm.createContext({window,document,URL,URLSearchParams,AbortController,Blob,setTimeout,clearTimeout,console,navigator:window.navigator,fetch:window.fetch,Date,JSON,localStorage:saved});
  const sourcePath=new URL('../dashboard/public/intelligence.js',import.meta.url);
  if(fs.existsSync(sourcePath))new vm.Script(fs.readFileSync(sourcePath,'utf8'),{filename:'intelligence.js'}).runInContext(context);
  const api=window.CrucixIntelligence;
  assert.ok(api,'CrucixIntelligence browser workspace must be available');
  api.init({getSnapshot:()=>snapshot,getLayout:()=>layout,applyLayout:v=>{layout=v;applied.push(['layout',v])},getLayers:()=>layers,applyLayers:v=>{layers=v;applied.push(['layers',v])},getRegion:()=>region,applyRegion:v=>{region=v;applied.push(['region',v])},t:(k,f)=>translations[k]||f,historyEnabled,profilesEnabled});
  // Capture download behavior at the DOM boundary without replacing module code.
  const originalCreate=document.createElement.bind(document);document.createElement=tag=>{const e=originalCreate(tag);if(tag==='a'){const base=e.click.bind(e);e.click=()=>{if(e.download)downloads.push({href:e.href,download:e.download});base()}}return e};
  return {api,document,window,main,existing,trigger,values,applied,downloads,opened,get state(){return {layout,layers,region}},setSnapshot:v=>snapshot=v};
}
function fixture(overrides={}) { return {id:'event-abc123',kind:'news',title:'Report title',summary:'Source summary',source:{name:'Provider',url:'https://example.org/report',hostname:'example.org',status:'ok'},observedAt:null,publishedAt:'2026-10-01T09:00:00Z',collectedAt:'2026-10-01T10:00:00Z',location:{lat:47.5,lon:19,method:'inferred',label:'Budapest',precision:'city'},severity:'monitor',quality:{level:'complete',checks:{sourceUrl:true,publishedTime:true,location:true},explanationCodes:[]},relatedSources:[],...overrides}; }
const byId=(h,id)=>h.document.getElementById(id);
const click=(h,s)=>{const e=h.document.querySelector(s);assert.ok(e,'Control exists: '+s);e.click();return e};
const change=(h,id,value,type='change')=>{const e=byId(h,id);assert.ok(e,'Field exists: '+id);e.value=value;e.dispatchEvent(event(type));};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));

test('event detail keeps payloads inert and refuses credential/javascript source URLs',async()=>{
  const h=harness();await h.api.openEvent(fixture({title:'<img src=x onerror=alert(1)>',summary:'<script>attack()</script>',source:{name:'<svg onload=attack()>',url:'javascript:alert(1)',status:'error'},relatedSources:[{id:'event-other',title:'<b>related</b>',source:{name:'Other',url:'https://user:secret@example.org/'}}]}));
  assert.match(byId(h,'ci-body').textContent,/<script>attack\(\)<\/script>/);assert.equal(byId(h,'ci-body').querySelectorAll('script,img,svg').length,0);
  assert.equal(byId(h,'ci-body').querySelectorAll('a').length,0);
  await h.api.openEvent(fixture());const link=byId(h,'ci-body').querySelector('a');assert.equal(link.href,'https://example.org/report');assert.equal(link.getAttribute('rel'),'noopener noreferrer');
});

test('tampered cached events cannot expose auth-bearing source or related-report URLs',async()=>{
  const h=harness();for(const key of ['ACCESS_TOKEN','refresh-token','api%5Fkey','token','secret','password','authorization','auth','signature']){await h.api.openEvent(fixture({source:{name:'Provider',status:'ok',url:'https://example.org/report?'+key+'=fixture-secret'},relatedSources:[{name:'Related',url:'https://other.example/report?'+key+'=fixture-secret'}]}));assert.equal(byId(h,'ci-body').querySelectorAll('a').length,0,'Auth-bearing URL withheld: '+key);}
  await h.api.openEvent(fixture({source:{name:'Provider',status:'ok',url:'https://example.org/report?article=123&utm_campaign=public'}}));assert.equal(byId(h,'ci-body').querySelector('a').href,'https://example.org/report?article=123&utm_campaign=public');
});

test('detail separates unknown provider times from collection and labels inferred geography',async()=>{
  const h=harness();await h.api.openEvent(fixture({location:{lat:47.5,lon:19,method:'inferred',precision:'city',label:'Budapest'}}));
  const text=byId(h,'ci-body').textContent;assert.match(text,/Observed/);assert.match(text,/Unknown/);assert.match(text,/Published/);assert.match(text,/Collected/);assert.match(text,/Inferred/);assert.match(text,/City/);assert.match(text,/metadata/i);assert.doesNotMatch(text,/100%|truth score/i);
  await h.api.openEvent(fixture({location:{lat:999,lon:NaN,method:'unknown'}}));assert.match(byId(h,'ci-body').textContent,/Unknown/);assert.doesNotMatch(byId(h,'ci-body').textContent,/999|NaN/);
});

test('detail localizes severity and known geolocation method codes',async()=>{
  const h=harness({translations:{'intelligence.severity_high':'Magas','intelligence.method_headline-keyword':'Cím alapján becsült'}});await h.api.openEvent(fixture({severity:'high',location:{lat:47,lon:19,method:'headline-keyword',precision:'approximate'}}));assert.match(byId(h,'ci-body').textContent,/Magas/);assert.match(byId(h,'ci-body').textContent,/Cím alapján becsült/);assert.doesNotMatch(byId(h,'ci-body').textContent,/headline-keyword/);
});

test('every location method a source adapter emits has a label in the detail and in en, hu and fr',async()=>{
  // The tokens are read from the adapters: each line that sets locationMethod, between it and locationPrecision (ternaries included).
  const dir=new URL('../apis/sources/',import.meta.url),tokens=new Set();
  for(const name of fs.readdirSync(dir).filter(file=>file.endsWith('.mjs')))for(const line of fs.readFileSync(new URL(name,dir),'utf8').split('\n')){const at=line.indexOf('locationMethod');if(at<0)continue;const end=line.indexOf('locationPrecision',at);for(const match of line.slice(at,end<0?undefined:end).matchAll(/'([a-z][a-z-]*)'/g))tokens.add(match[1]);}
  for(const token of ['provider','theater-centre','polygon-centroid','polygon-vertex-mean','configured-point'])assert(tokens.has(token),'the scan finds '+token);
  const locales=['en','hu','fr'].map(lang=>JSON.parse(fs.readFileSync(new URL(`../locales/${lang}.json`,import.meta.url),'utf8')).intelligence);
  for(const token of tokens){
    for(const [index,strings] of locales.entries())assert.ok(typeof strings['method_'+token]==='string'&&strings['method_'+token].trim(),`${['en','hu','fr'][index]}: intelligence.method_${token}`);
    const h=harness();await h.api.openEvent(fixture({location:{lat:47,lon:19,method:token,precision:'approximate'}}));
    assert.match(byId(h,'ci-body').textContent,new RegExp(locales[0]['method_'+token].replace(/[()]/g,'\\$&')),`${token}: the English label is the fallback`);
    const hu=harness({translations:{['intelligence.method_'+token]:locales[1]['method_'+token]}});await hu.api.openEvent(fixture({location:{lat:47,lon:19,method:token,precision:'approximate'}}));
    assert.match(byId(hu,'ci-body').textContent,new RegExp(locales[1]['method_'+token].replace(/[()]/g,'\\$&')),`${token}: translated`);
  }
});

test('metadata quality does not mark an unknown location method or failed source as available',async()=>{
  const h=harness();await h.api.openEvent(fixture({source:{name:'Provider',url:'https://example.org/report',status:'error'},location:{lat:47,lon:19,method:'unknown',precision:'unknown'}}));assert.equal(byId(h,'ci-body').querySelectorAll('.ci-check-missing').length,2);assert.doesNotMatch(byId(h,'ci-body').textContent,/Complete metadata/);
});

test('modal traps keyboard focus and restores prior inert, focus and scrolling on Escape',async()=>{
  const h=harness();h.document.body.style.overflow='auto';await h.api.openEvent(fixture());
  assert.equal(h.main.inert,true);assert.equal(byId(h,'ci-dialog').getAttribute('aria-modal'),'true');assert.equal(h.document.body.style.overflow,'hidden');
  const controls=byId(h,'ci-dialog').querySelectorAll('button,a,input,select,textarea');const first=controls[0],last=controls.at(-1);first.focus();h.document.dispatchEvent(event('keydown',{key:'Tab',shiftKey:true}));assert.ok(h.document.activeElement===last,'Shift+Tab from the first control wraps to the last');
  h.document.dispatchEvent(event('keydown',{key:'Tab'}));assert.ok(h.document.activeElement===first,'Tab from the last control wraps to the first');h.document.dispatchEvent(event('keydown',{key:'Escape'}));
  assert.equal(h.main.inert,false);assert.equal(h.existing.inert,true);assert.ok(h.document.activeElement===h.trigger,'the focus returns to the trigger');assert.equal(h.document.body.style.overflow,'auto');assert.ok(byId(h,'ci-overlay')===null,'the overlay is gone');
});

test('modal restores a replaced dashboard trigger by ID after applying a workspace',async()=>{
  const h=harness();await h.api.openEvent(fixture());h.trigger.remove();const replacement=h.document.createElement('button');replacement.id='trigger';h.main.appendChild(replacement);h.document.dispatchEvent(event('keydown',{key:'Escape'}));assert.ok(h.document.activeElement===replacement,'the focus goes to the replacement of the removed trigger');
});

test('feature flags gate history and profiles without network or storage side effects',()=>{
  let requests=0;const h=harness({fetch:async()=>{requests++;throw new Error('unexpected')}});assert.equal(h.api.openHistory(),false);assert.equal(h.api.openProfiles(),false);assert.equal(requests,0);assert.ok(byId(h,'ci-overlay')===null,'nothing opened');
});

test('related report opens the matching snapshot event rather than following an unsafe link',async()=>{
  const a=fixture({relatedSources:[{eventId:'event-second',name:'Another',url:'https://other.org',hostname:'other.org',relationship:'related-report'}]}),b=fixture({id:'event-second',title:'Second source'});const h=harness({snapshot:{events:[a,b]}});await h.api.openEvent(a);click(h,'[data-ci-event-id="event-second"]');await tick();assert.match(byId(h,'ci-title').textContent,/Second source/);
});

test('phase 2.4 offers a local event list and a bounded related geographic group without APIs',async()=>{
  let requests=0;const h=harness({snapshot:{events:[fixture(),fixture({id:'event-two',title:'Other report'}),fixture({id:'event-three',title:'Outside group'})]},fetch:async()=>{requests++;throw new Error('unexpected')}});
  assert.equal(h.api.openEvents?.(),true);assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-event-id]').length,3);click(h,'[data-ci-event-id="event-two"]');await tick();assert.equal(byId(h,'ci-title').textContent,'Other report');
  assert.equal(h.api.openCluster({eventIds:['event-abc123','event-two']}),true);assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-event-id]').length,2);assert.match(byId(h,'ci-body').textContent,/Geographic proximity alone/);assert.doesNotMatch(byId(h,'ci-body').textContent,/Outside group/);assert.equal(requests,0);
});

test('snapshot updates drive the bounded event list even before the host callback changes',()=>{
  const h=harness({snapshot:{events:[fixture({title:'Old snapshot'})]}});h.api.update({events:Array.from({length:250},(_,i)=>fixture({id:'event-'+i,title:'Updated '+i}))});h.api.openEvents();assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-event-id]').length,200);assert.doesNotMatch(byId(h,'ci-body').textContent,/Old snapshot/);assert.match(byId(h,'ci-body').textContent,/200.*250/);
});

test('history keeps current filters in paginated and export API requests',async()=>{
  const requests=[];const h=harness({historyEnabled:true,fetch:async url=>{requests.push(String(url));return {ok:true,json:async()=>({items:[fixture()],total:101,limit:50,offset:new URL(String(url),'http://localhost').searchParams.get('offset')*1,stats:{}})}}});
  h.api.openHistory();await tick();change(h,'ci-history-q','árvíz <img>', 'input');change(h,'ci-history-kind','news');change(h,'ci-history-source','Provider');change(h,'ci-history-from','2026-09-30');change(h,'ci-history-to','2026-10-01');await tick();
  click(h,'[data-ci-page="next"]');await tick();const query=new URL(requests.at(-1),'http://localhost').searchParams;assert.equal(query.get('q'),'árvíz <img>');assert.equal(query.get('kind'),'news');assert.equal(query.get('source'),'Provider');assert.equal(query.get('offset'),'50');assert.equal(query.get('from'),'2026-09-30T00:00:00.000Z');assert.equal(query.get('to'),'2026-10-01T23:59:59.999Z');
  click(h,'[data-ci-export="csv"]');const exported=new URL(h.downloads.at(-1).href,'http://localhost');assert.equal(exported.pathname,'/api/export');assert.equal(exported.searchParams.get('format'),'csv');assert.equal(exported.searchParams.get('q'),'árvíz <img>');assert.equal(exported.searchParams.has('offset'),false);
  click(h,'[data-ci-export="html"]');const printable=new URL(h.opened.at(-1),'http://localhost');assert.equal(printable.searchParams.get('format'),'html');assert.equal(printable.searchParams.get('kind'),'news');
});

test('history ignores older requests even when the fetch boundary ignores abort',async()=>{
  const pending=[];const h=harness({historyEnabled:true,fetch:url=>new Promise(resolve=>pending.push({url,resolve}))});h.api.openHistory();assert.equal(pending.length,1);change(h,'ci-history-kind','health');assert.equal(pending.length,2);
  pending[1].resolve({ok:true,json:async()=>({items:[fixture({title:'Newest request'})],total:1,limit:50,offset:0})});await tick();pending[0].resolve({ok:true,json:async()=>({items:[fixture({title:'Obsolete request'})],total:1,limit:50,offset:0})});await tick();assert.match(byId(h,'ci-body').textContent,/Newest request/);assert.doesNotMatch(byId(h,'ci-body').textContent,/Obsolete request/);
});

test('committing an unchanged completed search does not clear results during export activation',async()=>{
  const urls=[];const h=harness({historyEnabled:true,fetch:async url=>{urls.push(String(url));return {ok:true,json:async()=>({items:[fixture()],total:1,limit:50,offset:0,stats:{}})}}});h.api.openHistory();await tick();change(h,'ci-history-q','Report','input');await new Promise(resolve=>setTimeout(resolve,330));assert.equal(urls.length,2);assert.equal(byId(h,'ci-body').querySelectorAll('.ci-event-card').length,1);
  change(h,'ci-history-q','Report','change');assert.equal(urls.length,2,'Blur does not start a redundant query or shrink the dialog');assert.equal(byId(h,'ci-body').querySelectorAll('.ci-event-card').length,1);click(h,'[data-ci-export="json"]');assert.equal(h.downloads.length,1);
});

test('history type filter offers only API-supported event categories',async()=>{
  const h=harness({historyEnabled:true});h.api.openHistory();await tick();const values=byId(h,'ci-history-kind').children.map(option=>option.value);assert.deepEqual(values.sort(),['','aviation','conflict','cyber','disaster','displacement','earthquake','economic','energy','forecast','health','interference','maritime','market','network','news','osint','outage','sanctions','signal','space-weather','weather']);
});

test('history type filter labels every kind in English and in the locale',async()=>{
  const hu=JSON.parse(fs.readFileSync(new URL('../locales/hu.json',import.meta.url),'utf8')).intelligence,translations=Object.fromEntries(Object.entries(hu).map(([key,value])=>['intelligence.'+key,value]));
  const english=harness({historyEnabled:true});english.api.openHistory();await tick();const labelled=byId(english,'ci-history-kind').children.filter(option=>option.value);
  assert.equal(labelled.length,21);for(const option of labelled)assert.notEqual(option.textContent,option.value,'English: '+option.value+' shows a label, not the raw code');
  assert.deepEqual(['aviation','sanctions','market','energy'].map(kind=>labelled.find(option=>option.value===kind).textContent),['Aviation','Sanctions','Prediction market','Energy']);
  const local=harness({historyEnabled:true,translations});local.api.openHistory();await tick();
  for(const option of byId(local,'ci-history-kind').children.filter(option=>option.value))assert.equal(option.textContent,hu['kind_'+option.value],option.value);
});

test('history reports empty, failed and offline states and clamps invalid page size',async()=>{
  let fail=false;const urls=[];const h=harness({historyEnabled:true,fetch:async url=>{urls.push(String(url));if(fail)throw new Error('<script>server failure</script>');return {ok:true,json:async()=>({items:[],total:0,limit:50,offset:0})}}});h.api.openHistory();await tick();assert.match(byId(h,'ci-body').textContent,/No events/);change(h,'ci-history-limit','999');await tick();assert.equal(new URL(urls.at(-1),'http://localhost').searchParams.get('limit'),'200');
  fail=true;change(h,'ci-history-kind','news');await tick();assert.match(byId(h,'ci-body').textContent,/Could not load/);assert.doesNotMatch(byId(h,'ci-body').textContent,/server failure/);h.window.navigator.onLine=false;change(h,'ci-history-kind','health');await tick();assert.match(byId(h,'ci-body').textContent,/Offline/);
});

test('during a sweep replay history, export and event lookups by id are off and say why',async()=>{
  const urls=[];const h=harness({historyEnabled:true,fetch:async url=>{urls.push(String(url));return {ok:true,json:async()=>({items:[fixture()],total:1,limit:50,offset:0,stats:{}})}}});
  let replaying=true;h.window.CrucixReplay={active:()=>replaying,historyNote:()=>'REPLAY NOTE <b>'};
  assert.equal(h.api.openHistory(),true,'the dialog opens with the explanation');await tick();
  assert.deepEqual(urls,[],'no /api/history request');assert.match(byId(h,'ci-body').textContent,/REPLAY NOTE <b>/);assert.equal(h.document.querySelectorAll('[data-ci-export]').length,0,'no export buttons');
  assert.equal(await h.api.openEvent('event-not-in-snapshot'),false);assert.deepEqual(urls,[],'no /api/events/:id request');assert.match(byId(h,'ci-body').textContent,/REPLAY NOTE/);
  h.setSnapshot({events:[fixture({id:'event-replayed',title:'Replayed record'})]});assert.equal(await h.api.openEvent('event-replayed'),true,'records of the replayed sweep still open');assert.equal(byId(h,'ci-title').textContent,'Replayed record');
  replaying=false;h.api.openHistory();await tick();assert.equal(urls.length,1,'live again: history loads');
  replaying=true;change(h,'ci-history-kind','news');await tick();assert.equal(urls.length,1,'a filter change during a replay fetches nothing');assert.match(byId(h,'ci-body').textContent,/REPLAY NOTE/);
  click(h,'[data-ci-export="csv"]');click(h,'[data-ci-export="html"]');assert.equal(h.downloads.length,0);assert.equal(h.opened.length,0,'no export during a replay');
});

test('saved profiles normalize hostile settings and keep twelve own entries at most',()=>{
  const profiles=Array.from({length:20},(_,i)=>({id:'user-'+i,name:'Profile '+i,layout:{zones:{left:['sensorGrid','evil','sensorGrid'],right:['newsTicker']},visibility:{newsTicker:false,evil:false},fixed:{map:false,evil:false}},layers:{news:false,evil:false},region:'malicious'}));const storage={getItem:()=>JSON.stringify({version:1,profiles}),setItem(){}};const h=harness({profilesEnabled:true,storage});h.api.openProfiles();
  assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-profile-action="delete"]').length,12);click(h,'[data-ci-profile-action="apply"][data-profile-id="user-0"]');
  assert.equal(h.state.region,'world');assert.equal(h.state.layers.news,false);assert.equal(Object.hasOwn(h.state.layers,'evil'),false);assert.equal(Object.hasOwn(h.state.layout.visibility,'evil'),false);assert.equal(Object.values(h.state.layout.zones).flat().length,18);assert.equal(new Set(Object.values(h.state.layout.zones).flat()).size,18);
  change(h,'ci-profile-name','13th');click(h,'[data-ci-profile-action="save"]');assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-profile-action="delete"]').length,12);assert.match(byId(h,'ci-body').textContent,/12/);
});

test('profiles save, rename and delete only own entries with blocked-storage session fallback',()=>{
  const storage={getItem(){throw new Error('denied')},setItem(){throw new Error('denied')}};const h=harness({profilesEnabled:true,storage});h.api.openProfiles();assert.match(byId(h,'ci-body').textContent,/session/i);change(h,'ci-profile-name','<script>Saved view</script>');click(h,'[data-ci-profile-action="save"]');let own=byId(h,'ci-body').querySelector('[data-ci-profile-action="delete"]');assert.ok(own);const id=own.dataset.profileId;assert.equal(byId(h,'ci-body').querySelectorAll('script').length,0);
  click(h,'[data-ci-profile-action="rename"][data-profile-id="'+id+'"]');change(h,'ci-profile-name','Renamed');click(h,'[data-ci-profile-action="save"]');assert.match(byId(h,'ci-body').textContent,/Renamed/);assert.doesNotMatch(byId(h,'ci-body').textContent,/<script>/);
  assert.ok(byId(h,'ci-body').querySelector('[data-ci-profile-action="delete"][data-profile-id="research"]')===null,'a preset has no delete button');click(h,'[data-ci-profile-action="delete"][data-profile-id="'+id+'"]');assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-profile-action="delete"]').length,0);
});

test('preset switching retains the original custom workspace and allows restoring it',()=>{
  const h=harness({profilesEnabled:true});const before=JSON.parse(JSON.stringify(h.state));h.api.openProfiles();click(h,'[data-ci-profile-action="apply"][data-profile-id="research"]');click(h,'[data-ci-profile-action="apply"][data-profile-id="market"]');click(h,'[data-ci-profile-action="apply"][data-profile-id="custom"]');assert.equal(h.state.region,before.region);assert.equal(h.state.layout.visibility.tradeIdeas,true);assert.equal(h.state.layout.zones.center2[0],'macroMarkets');assert.equal(h.state.layers.news,true);
});

test('every workspace preset shows the What changed panel first in the right rail, and an older saved profile gets it too',()=>{
  for(const id of ['research','market','infrastructure']){const h=harness({profilesEnabled:true});h.api.openProfiles();click(h,'[data-ci-profile-action="apply"][data-profile-id="'+id+'"]');assert.equal(h.state.layout.zones.right[0],'changes',id);assert.equal(h.state.layout.visibility.changes,true,id);}
  const old={id:'user-old',name:'Before the panel',layout:{zones:{left:['sensorGrid'],right:['sweepDelta']},visibility:{sweepDelta:true},fixed:{}},layers:{},region:'world'};
  const h=harness({profilesEnabled:true,storage:{getItem:()=>JSON.stringify({version:1,profiles:[old]}),setItem(){}}});h.api.openProfiles();click(h,'[data-ci-profile-action="apply"][data-profile-id="user-old"]');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.layout.zones.right.slice(0,3))),['changes','countryRisk','sweepDelta'],'a profile that never held the panels gets them on top (Country risk under What changed), the saved order after them');assert.equal(h.state.layout.visibility.changes,true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.layout.zones.left.slice(0,1))),['sensorGrid']);
});

test('a stored profile keeps its own arrangement of the panel: in another zone it stays, a hidden one is not turned on or put on top',()=>{
  const profile=(id,layout)=>({id,name:id,layout,layers:{},region:'world'});
  const applied=id=>{const stored=[profile('user-left',{zones:{left:['sensorGrid','changes'],right:['sweepDelta']},visibility:{changes:true},fixed:{}}),profile('user-hidden',{zones:{left:['sensorGrid'],right:['sweepDelta']},visibility:{changes:false},fixed:{}}),profile('user-entry',{zones:{left:['sensorGrid'],right:['sweepDelta']},visibility:{changes:true},fixed:{}})];
    const h=harness({profilesEnabled:true,storage:{getItem:()=>JSON.stringify({version:1,profiles:stored}),setItem(){}}});h.api.openProfiles();click(h,'[data-ci-profile-action="apply"][data-profile-id="'+id+'"]');return h.state.layout;};
  const left=applied('user-left');assert.deepEqual(JSON.parse(JSON.stringify(left.zones.left.slice(0,2))),['sensorGrid','changes'],'the panel the profile put in the left rail stays there');assert.equal(left.zones.right.includes('changes'),false);
  const hidden=applied('user-hidden');assert.equal(hidden.visibility.changes,false,'a hidden panel stays hidden');assert.notEqual(hidden.zones.right[0],'changes');assert.deepEqual(JSON.parse(JSON.stringify(hidden.zones.right.slice(0,2))),['countryRisk','sweepDelta'],'only the never-seen Country risk goes on top');
  const entry=applied('user-entry');assert.notEqual(entry.zones.right[0],'changes','a visibility entry means the profile has seen the panel');assert.equal(entry.visibility.changes,true);
});

test('oversized and malformed profile storage leaves presets usable',()=>{
  for(const raw of ['{bad json','x'.repeat(150000),JSON.stringify({version:1,profiles:[{id:'research',name:'Replace preset',layout:{}}]})]){const h=harness({profilesEnabled:true,storage:{getItem:()=>raw,setItem(){}}});h.api.openProfiles();assert.ok(byId(h,'ci-body').querySelector('[data-profile-id="research"]'));assert.equal(byId(h,'ci-body').querySelectorAll('[data-ci-profile-action="delete"]').length,0);}
});
