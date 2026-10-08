(function(window){
  'use strict';
  // The alert rule editor: the content of the alert tray's Rules tab. Needs record-core.js and alerts-core.js
  // (window.CrucixAlertsCore) loaded first; alerts.js (window.CrucixAlerts) is reached at call time (request, summary, redraw).
  const {LEVELS,GLYPH,esc}=window.CrucixAlertsCore;

  // ===== Render and conversion =====
  // Pure: no DOM, no fetch, no timers. renderRules returns an HTML string in which every dynamic value is escaped (text and
  // attributes), there are no inline handlers and nothing is keyed by a rule id. Controls carry data-rule-action (button),
  // data-rule-toggle + data-rule-id (list checkboxes) or name (form fields, the keys of a draft); every form field sits in a
  // wrapper with data-rule-field="<the server's field path>", which is where a server error is shown. A draft is the flat set
  // of form values (strings, booleans, one array); parseDraft turns it into the body of PUT /api/alerts/rules/:id.
  const KINDS=['event','threshold','change','absence','convergence','delta'];
  // The kinds of events the dashboard can hold (lib/intelligence/history.mjs); a rule may name others, they stay selectable.
  const EVENT_KINDS=['news','osint','health','earthquake','weather','outage','conflict','signal','disaster','space-weather','economic','forecast','network','cyber','maritime','aviation','sanctions','market','energy', 'interference'];
  const KIND_TEXT={event:'Event',threshold:'Threshold',change:'Change',absence:'Absence',convergence:'Convergence',delta:'Delta'};
  const SOURCE_TEXT={builtin:'Built-in',override:'Modified',user:'Custom'};
  const OPERATORS=[['>','>'],['>=','≥'],['<','<'],['<=','≤']];
  const SOURCES=['builtin','override','user'];
  const FLAGS=['enabled','notify'];
  // What a built-in accepts (it replaces params and scope wholesale), and what a user rule consists of.
  const OVERRIDE_FIELDS=['enabled','notify','severity','forSweeps','cooldownMinutes','params','scope'];
  const USER_FIELDS=['name','kind','enabled','severity','notify','forSweeps','cooldownMinutes','scope','params'];
  const DRAFT_KEYS=['name','id','kind','enabled','notify','severity','forSweeps','cooldownMinutes','minLevel','maxLevel','kinds','sources','keywords','lat','lon','km','metric','op','value','clearValue','pct','source','minFailSweeps','maxAgeMinutes','cellDegrees','windowHours','minKinds','minSeverity'];
  const HUNGARY={lat:'47.5',lon:'19',km:'500'};
  const RULE_ID=/^[a-z0-9-]{1,40}$/,TOKEN=/^[a-z][a-z0-9-]{0,29}$/,KEY=/^[a-z][a-z0-9_]{0,39}$/,MAX_LIST=100;
  const obj=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:null;
  const text=value=>typeof value==='string'?value:'';
  const items=value=>Array.isArray(value)?value.filter(obj):[];
  // An own property only: a draft or rule never takes a field from its prototype.
  const own=(source,key)=>obj(source)&&Object.hasOwn(source,key)?source[key]:undefined;
  const put=(target,key,value)=>{if(value!==undefined)target[key]=value;return target;};
  const pick=(source,keys)=>{const out={};for(const key of keys)if(obj(source)&&Object.hasOwn(source,key))out[key]=source[key];return out;};
  const levelOf=value=>LEVELS.includes(value)?value:'unknown';

  // Translators never throw and give text: `raw` is plain, `tx` escaped.
  function speak(t){
    const raw=(key,fallback)=>{let value=fallback;try{if(typeof t==='function')value=t(key,fallback);}catch{value=fallback;}return typeof value==='string'&&value?value:fallback;};
    return {raw,tx:(key,fallback)=>esc(raw(key,fallback))};
  }
  // A template with {name} slots: the template is escaped, the values arrive escaped.
  const fill=(template,values)=>esc(template).replace(/\{(\w+)\}/g,(match,name)=>Object.hasOwn(values,name)?values[name]:match);
  const shown=value=>typeof value==='number'&&Number.isFinite(value)?String(Math.round(value*1000)/1000):typeof value==='string'?value.slice(0,80):'?';
  const shownList=value=>Array.isArray(value)?value.slice(0,20).map(shown).join(', '):'?';

  // ----- the metric catalog -----
  const catalogOf=metrics=>{const map=new Map();for(const metric of items(metrics))if(typeof metric.key==='string'&&!map.has(metric.key))map.set(metric.key,metric);return map;};
  // The server's metric labels are English constants: a locale key per metric, the server label as the fallback.
  const metricName=(env,key)=>{const entry=env.catalog.get(key),fallback=text(entry?.label)||shown(key);return KEY.test(text(key))?env.tx('alerts.rules.metric.'+key,fallback):esc(fallback);};
  const unitName=(env,unit)=>/^[a-z]+(?:\/[a-z]+)?$/.test(text(unit))?env.tx('alerts.rules.unit.'+unit,unit):esc(text(unit));
  const valueName=value=>typeof value==='number'&&Number.isFinite(value)?esc(String(Math.round(value*1000)/1000)):'—';
  const levelName=(env,level)=>levelOf(level)==='unknown'?env.tx('inspector.level.unknown','Unknown'):env.tx('alerts.level.'+level,level[0].toUpperCase()+level.slice(1));
  const kindName=(env,token)=>{const word=text(token);return TOKEN.test(word)?env.tx('intelligence.kind_'+word,word[0].toUpperCase()+word.slice(1).replace(/-/g,' ')):esc(shown(token));};
  const ruleName=(env,rule)=>{const id=text(rule.id),name=text(rule.name)||id;return RULE_ID.test(id)?env.tx('alerts.ruleNames.'+id,name):esc(name);};

  // ----- one-line summaries (symbols where a word would only get in the way) -----
  const lv=(env,level)=>levelName(env,level);
  const SUMMARY={
    event(env,{params,scope}){
      const lo=params.minLevel,hi=params.maxLevel;
      const levels=hi!==undefined&&hi===lo?`= ${lv(env,lo)}`:hi!==undefined&&hi!=='critical'?`${lv(env,lo)}–${lv(env,hi)}`:`≥ ${lv(env,lo)}`;
      const parts=[levels];
      for(const [key,word] of [['kinds','types'],['sources','sources'],['keywords','keywords']])if(Array.isArray(scope[key]))parts.push(`${env.tx('alerts.rules.summary.'+key,word)}: ${esc(shownList(scope[key]))}`);
      const radius=obj(scope.radius);
      if(radius)parts.push(`${esc(shown(radius.km))} km @ ${esc(shown(radius.lat))}, ${esc(shown(radius.lon))}`);
      return parts.join(' · ');
    },
    threshold(env,{params}){
      const clear=params.clearValue===undefined?'':` (${env.tx('alerts.rules.summary.clears','clears at')} ${esc(shown(params.clearValue))})`;
      return `${metricName(env,params.metric)} ${esc(shown(params.op))} ${esc(shown(params.value))}${clear}`;
    },
    change:(env,{params})=>`${metricName(env,params.metric)} ±${esc(shown(params.pct))}%`,
    absence(env,{params}){
      const source=params.source==='any'?env.tx('alerts.rules.summary.any','any source'):esc(shown(params.source));
      const age=params.maxAgeMinutes===undefined?'':', '+fill(env.raw('alerts.rules.summary.absenceAge','older than {minutes} min'),{minutes:esc(shown(params.maxAgeMinutes))});
      return fill(env.raw('alerts.rules.summary.absence','{source}: {sweeps}+ failed sweeps in a row'),{source,sweeps:esc(shown(params.minFailSweeps))})+age;
    },
    convergence(env,{params}){
      const main=fill(env.raw('alerts.rules.summary.convergence','{kinds}+ event types within one {cell}° cell in {hours} h at {level} or above'),
        {kinds:esc(shown(params.minKinds)),cell:esc(shown(params.cellDegrees)),hours:esc(shown(params.windowHours)),level:lv(env,params.minLevel)});
      return Array.isArray(params.kinds)?`${main} · ${env.tx('alerts.rules.summary.kinds','types')}: ${esc(shownList(params.kinds))}`:main;
    },
    delta:(env,{params})=>`≥ ${lv(env,params.minSeverity)}`,
  };
  function describe(env,rule){
    if(!Object.hasOwn(SUMMARY,text(rule.kind)))return '';
    try{return SUMMARY[rule.kind](env,{params:obj(rule.params)||{},scope:obj(rule.scope)||{}});}catch{return '';}
  }

  // ----- draft <-> rule -----
  const asText=value=>typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):'';
  const textOf=value=>value===undefined||value===null?'':asText(value);
  const listText=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').join(', '):'';
  const tokens=value=>(Array.isArray(value)?value:[]).filter(item=>typeof item==='string').slice(0,MAX_LIST);
  const SHARED={enabled:true,notify:false,cooldownMinutes:'30',name:'',id:''};
  const DEFAULTS=metric=>({
    event:{severity:'auto',forSweeps:'1',minLevel:'high',maxLevel:'',kinds:[],sources:'',keywords:'',lat:'',lon:'',km:''},
    threshold:{severity:'high',forSweeps:'2',metric,op:'>',value:'',clearValue:''},
    change:{severity:'high',forSweeps:'1',metric,pct:'5'},
    absence:{severity:'high',forSweeps:'1',source:'any',minFailSweeps:'3',maxAgeMinutes:''},
    convergence:{severity:'high',forSweeps:'1',cellDegrees:'2',windowHours:'24',minKinds:'3',minLevel:'watch',kinds:[]},
    delta:{severity:'high',forSweeps:'1',minSeverity:'critical'},
  });
  /** The form values of a new rule of `kind` (the first catalog metric where a metric is wanted). */
  function newDraft(kind,metrics){
    const known=KINDS.includes(kind)?kind:'event',first=items(metrics).find(metric=>typeof metric.key==='string');
    return {...SHARED,kind:known,...DEFAULTS(first?first.key:'vix')[known]};
  }
  /** The form values of an effective rule. */
  function draftOf(rule){
    const r=obj(rule)||{},params=obj(r.params)||{},scope=obj(r.scope)||{},radius=obj(scope.radius)||{};
    const draft=newDraft(text(r.kind));
    const set=(key,value)=>{draft[key]=value;};
    set('name',textOf(r.name));set('id',textOf(r.id));
    set('enabled',r.enabled!==false);set('notify',r.notify===true);
    if(typeof r.severity==='string')set('severity',r.severity);
    for(const key of ['forSweeps','cooldownMinutes'])if(r[key]!==undefined)set(key,textOf(r[key]));
    for(const key of ['minLevel','maxLevel','metric','op','value','clearValue','pct','source','minFailSweeps','maxAgeMinutes','cellDegrees','windowHours','minKinds','minSeverity'])if(params[key]!==undefined)set(key,textOf(params[key]));
    if(draft.kind==='event'){
      set('kinds',tokens(scope.kinds));set('sources',listText(scope.sources));set('keywords',listText(scope.keywords));
      for(const key of ['lat','lon','km'])set(key,textOf(radius[key]));
    }else if(draft.kind==='convergence')set('kinds',tokens(params.kinds));
    return draft;
  }
  // A number as typed (a decimal comma is fine); anything else is sent as typed, so the server names the field. '' = absent.
  const NUMBER=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  function num(value){
    if(typeof value==='number')return Number.isFinite(value)?value:undefined;
    const raw=typeof value==='string'?value.trim():'';
    if(raw==='')return undefined;
    const dotted=/^[+-]?\d+,\d+$/.test(raw)?raw.replace(',','.'):raw,number=NUMBER.test(dotted)?Number(dotted):NaN;
    return Number.isFinite(number)?number:raw;
  }
  const flag=value=>value===true||value==='on'||value==='true'||value==='1';
  // A comma list: trimmed, empty items dropped, bounded (the server's own limits are far lower).
  const split=value=>typeof value==='string'?value.split(',').map(item=>item.trim()).filter(Boolean).slice(0,MAX_LIST):[];
  /** The body of PUT /api/alerts/rules/:id for the form values (the id is the URL's). Never mutates; reads own properties only. */
  function parseDraft(values){
    const v=obj(values)||{},get=name=>own(v,name);
    const str=name=>{const value=get(name);return typeof value==='string'?value.trim():asText(value);};
    const kind=str('kind'),rule={name:str('name'),kind,enabled:flag(get('enabled')),severity:str('severity'),notify:flag(get('notify'))};
    put(rule,'forSweeps',num(get('forSweeps')));put(rule,'cooldownMinutes',num(get('cooldownMinutes')));
    const params={},kinds=tokens(get('kinds')).map(item=>item.trim()).filter(Boolean);
    if(kind==='event'){
      params.minLevel=str('minLevel');if(str('maxLevel'))params.maxLevel=str('maxLevel');
      const scope={},sources=split(get('sources')),keywords=split(get('keywords')),radius={};
      if(kinds.length)scope.kinds=kinds;if(sources.length)scope.sources=sources;if(keywords.length)scope.keywords=keywords;
      for(const key of ['lat','lon','km'])put(radius,key,num(get(key)));
      if(Object.keys(radius).length)scope.radius=radius;
      rule.scope=scope;
    }else if(kind==='threshold'){
      params.metric=str('metric');params.op=str('op');put(params,'value',num(get('value')));put(params,'clearValue',num(get('clearValue')));
    }else if(kind==='change'){
      params.metric=str('metric');put(params,'pct',num(get('pct')));
    }else if(kind==='absence'){
      params.source=str('source');put(params,'minFailSweeps',num(get('minFailSweeps')));put(params,'maxAgeMinutes',num(get('maxAgeMinutes')));
    }else if(kind==='convergence'){
      put(params,'cellDegrees',num(get('cellDegrees')));put(params,'windowHours',num(get('windowHours')));put(params,'minKinds',num(get('minKinds')));
      params.minLevel=str('minLevel');if(kinds.length)params.kinds=kinds;
    }else if(kind==='delta')params.minSeverity=str('minSeverity');
    rule.params=params;
    return rule;
  }
  /** A rule id from a name: a-z, 0-9 and single dashes, at most 40 characters; '' when nothing is left. */
  const slug=name=>text(typeof name==='number'?String(name):name).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/,'');
  // The first free id: the slug, else slug-2, slug-3 ... (kept within 40 characters).
  function uniqueId(base,taken){
    const word=base||'rule';
    for(let n=1;n<1000;n++){
      const suffix=n===1?'':'-'+n,id=word.slice(0,40-suffix.length).replace(/-+$/,'')+suffix;
      if(!taken.has(id))return id;
    }
    return word;
  }

  // ----- the form -----
  const dash=path=>'ar-err-'+path.replace(/[^a-z0-9]+/gi,'-');
  const val=(draft,name)=>{const value=own(draft,name);return typeof value==='string'?value:typeof value==='number'?asText(value):'';};
  const checked=(draft,name)=>own(draft,name)===true;
  // A field: label, control (a function of the aria attributes of an invalid field) and the server's message for this path.
  function field(ctx,{path,id,label,control,hint='',cls=''}){
    const bad=ctx.errorPath===path,attrs=bad?` aria-invalid="true" aria-describedby="${dash(path)}"`:'';
    return `<div class="ar-field${cls}" data-rule-field="${esc(path)}"><label class="ar-label" for="${id}">${label}</label>${control(attrs)}${hint}${bad?`<p class="ar-error" id="${dash(path)}">${esc(ctx.error.message)}</p>`:''}</div>`;
  }
  const textInput=(ctx,name,{mode='',max=0}={})=>attrs=>`<input id="ar-${name}" name="${name}" type="text"${mode?` inputmode="${mode}"`:''}${max?` maxlength="${max}"`:''} value="${esc(val(ctx.draft,name))}" autocomplete="off"${attrs}${ctx.dis}>`;
  const selectInput=(ctx,name,options)=>attrs=>`<select id="ar-${name}" name="${name}"${attrs}${ctx.dis}>${options.map(([value,label])=>`<option value="${esc(value)}"${value===val(ctx.draft,name)?' selected':''}>${label}</option>`).join('')}</select>`;
  const levelOptions=(env,first=[])=>[...first,...LEVELS.map(level=>[level,levelName(env,level)])];
  const LABELS={forSweeps:'Sweeps to confirm',cooldown:'Cooldown (minutes)',failSweeps:'Consecutive failed sweeps',maxAge:'Max age (minutes)',window:'Window (hours)',minKinds:'Distinct event types',lat:'Latitude',lon:'Longitude',km:'Radius (km)',value:'Value',clearValue:'Clear value',percent:'Change %'};
  const label=(env,key)=>env.tx('alerts.rules.'+key,LABELS[key]);
  const intField=(ctx,path,name,key,max=0)=>field(ctx,{path,id:'ar-'+name,label:label(ctx.env,key),control:textInput(ctx,name,{mode:'numeric',max})});
  const decimalField=(ctx,path,name,key)=>field(ctx,{path,id:'ar-'+name,label:label(ctx.env,key),control:textInput(ctx,name,{mode:'decimal',max:24})});
  const checkField=(ctx,name,label,fallback)=>{
    const bad=ctx.errorPath===name;
    return `<div class="ar-field ar-check" data-rule-field="${name}"><label class="ar-check-label"><input type="checkbox" id="ar-${name}" name="${name}"${checked(ctx.draft,name)?' checked':''}${bad?` aria-invalid="true" aria-describedby="${dash(name)}"`:''}${ctx.dis}><span>${ctx.env.tx('alerts.rules.'+label,fallback)}</span></label>${bad?`<p class="ar-error" id="${dash(name)}">${esc(ctx.error.message)}</p>`:''}</div>`;
  };
  // The event kinds as checkboxes: the known ones plus any token the rule already carries.
  function kindsField(ctx,path,label){
    const draft=tokens(own(ctx.draft,'kinds')),all=[...EVENT_KINDS,...draft.filter(token=>!EVENT_KINDS.includes(token))],bad=ctx.errorPath===path;
    const boxes=all.map(token=>`<label class="ar-kind"><input type="checkbox" name="kinds" value="${esc(token)}" id="ar-kind-${esc(token)}"${draft.includes(token)?' checked':''}${ctx.dis}><span>${kindName(ctx.env,token)}</span></label>`).join('');
    return `<fieldset class="ar-field ar-kinds" data-rule-field="${path}"${bad?` aria-invalid="true" aria-describedby="${dash(path)}"`:''}><legend class="ar-label">${label}</legend><div class="ar-kind-list">${boxes}</div>${bad?`<p class="ar-error" id="${dash(path)}">${esc(ctx.error.message)}</p>`:''}</fieldset>`;
  }
  function metricField(ctx,path){
    const {env}=ctx,current=val(ctx.draft,'metric'),catalog=env.catalog;
    const list=[...catalog.values()];
    if(current&&!catalog.has(current))list.push({key:current,label:current,unit:'',value:null});
    const options=list.map(metric=>{
      const unit=Number.isFinite(metric.value)&&text(metric.unit)?` ${unitName(env,metric.unit)}`:'';
      return `<option value="${esc(metric.key)}"${metric.key===current?' selected':''}>${metricName(env,metric.key)} — ${valueName(metric.value)}${unit}</option>`;
    }).join('');
    const entry=catalog.get(current),now=entry&&Number.isFinite(entry.value)?`<p class="ar-hint">${env.tx('alerts.rules.current','current')}: ${valueName(entry.value)}${text(entry.unit)?` ${unitName(env,entry.unit)}`:''}</p>`:'';
    return field(ctx,{path,id:'ar-metric',label:env.tx('alerts.rules.metricField','Metric'),control:attrs=>`<select id="ar-metric" name="metric"${attrs}${ctx.dis}>${options}</select>`,hint:now});
  }
  function kindFields(ctx,kind){
    const {env}=ctx,tx=env.tx;
    if(kind==='event')return field(ctx,{path:'params.minLevel',id:'ar-minLevel',label:tx('alerts.rules.minLevel','Minimum level'),control:selectInput(ctx,'minLevel',levelOptions(env))})
      +field(ctx,{path:'params.maxLevel',id:'ar-maxLevel',label:tx('alerts.rules.maxLevel','Maximum level'),control:selectInput(ctx,'maxLevel',levelOptions(env,[['',tx('alerts.rules.noLimit','No limit')]]))})
      +kindsField(ctx,'scope.kinds',tx('alerts.rules.eventKinds','Event types'))
      +field(ctx,{path:'scope.sources',id:'ar-sources',label:tx('alerts.rules.sources','Sources (comma separated)'),control:textInput(ctx,'sources',{max:600})})
      +field(ctx,{path:'scope.keywords',id:'ar-keywords',label:tx('alerts.rules.keywords','Keywords (comma separated)'),control:textInput(ctx,'keywords',{max:600})})
      +`<div class="ar-group" role="group" aria-labelledby="ar-radius-label"><div class="ar-group-head"><span class="ar-label" id="ar-radius-label">${tx('alerts.rules.radius','Radius (lat, lon, km)')}</span><button type="button" class="al-btn" data-rule-action="preset-hungary"${ctx.dis}>${tx('alerts.rules.presetHungary','Hungary region')}</button></div><div class="ar-radius">`
      +decimalField(ctx,'scope.radius.lat','lat','lat')+decimalField(ctx,'scope.radius.lon','lon','lon')+decimalField(ctx,'scope.radius.km','km','km')+'</div></div>';
    if(kind==='threshold')return metricField(ctx,'params.metric')
      +field(ctx,{path:'params.op',id:'ar-op',label:tx('alerts.rules.operator','Operator'),control:selectInput(ctx,'op',OPERATORS.map(([value,label])=>[value,esc(label)]))})
      +decimalField(ctx,'params.value','value','value')+decimalField(ctx,'params.clearValue','clearValue','clearValue');
    if(kind==='change')return metricField(ctx,'params.metric')+decimalField(ctx,'params.pct','pct','percent');
    if(kind==='absence')return field(ctx,{path:'params.source',id:'ar-source',label:tx('alerts.rules.sourceName','Source (or any)'),control:textInput(ctx,'source',{max:40})})
      +intField(ctx,'params.minFailSweeps','minFailSweeps','failSweeps',3)+intField(ctx,'params.maxAgeMinutes','maxAgeMinutes','maxAge',6);
    if(kind==='convergence')return field(ctx,{path:'params.cellDegrees',id:'ar-cellDegrees',label:tx('alerts.rules.cell','Grid cell (degrees)'),control:selectInput(ctx,'cellDegrees',['1','2','4'].map(value=>[value,esc(value)]))})
      +intField(ctx,'params.windowHours','windowHours','window',3)+intField(ctx,'params.minKinds','minKinds','minKinds',2)
      +field(ctx,{path:'params.minLevel',id:'ar-minLevel',label:tx('alerts.rules.minLevel','Minimum level'),control:selectInput(ctx,'minLevel',levelOptions(env))})
      +kindsField(ctx,'params.kinds',tx('alerts.rules.eventKinds','Event types'));
    return field(ctx,{path:'params.minSeverity',id:'ar-minSeverity',label:tx('alerts.rules.minSeverity','Minimum severity'),control:selectInput(ctx,'minSeverity',['high','critical'].map(level=>[level,levelName(env,level)]))});
  }
  const fixed=(label,value)=>`<div class="ar-field ar-static"><span class="ar-label">${label}</span><span class="ar-static-value">${value}</span></div>`;
  function form(env,v,rules){
    const edit=obj(v.editing),isNew=edit.id===null||edit.id===undefined,existing=isNew?null:rules.find(rule=>rule.id===edit.id)||null;
    const builtin=!!existing&&existing.source!=='user'&&SOURCES.includes(existing.source),tx=env.tx;
    const draft=obj(edit.draft)||(existing?draftOf(existing):newDraft('event',v.metrics));
    const kind=KINDS.includes(own(draft,'kind'))?draft.kind:'event',error=obj(edit.error),errorPath=text(error?.field).replace(/\[\d+\]/g,'');
    const ctx={env,draft,error,errorPath,dis:v.busy===true?' disabled':''};
    const heading=isNew?tx('alerts.rules.add','New rule'):existing?ruleName(env,existing):esc(shown(edit.id));
    // The top line says the rule was not saved; a field the form does not show is named there as well.
    const mapped=!!error&&fieldNames(kind,isNew,builtin).includes(errorPath),rest=mapped?'':[text(error?.field),text(error?.message)].filter(Boolean).join(' ');
    const top=error?`<p class="al-notice ar-notice" tabindex="-1">${tx('alerts.rules.errorSave','Could not save the rule')}${rest?`: ${esc(rest)}`:''}</p>`:'';
    const kindOptions=KINDS.map(name=>[name,tx('alerts.rules.kind.'+name,KIND_TEXT[name])]);
    const common=(isNew?field(ctx,{path:'name',id:'ar-name',label:tx('alerts.rules.name','Name'),control:textInput(ctx,'name',{max:80})})
        +field(ctx,{path:'id',id:'ar-id',label:tx('alerts.rules.id','ID'),control:textInput(ctx,'id',{max:40}),hint:`<p class="ar-hint">${tx('alerts.rules.idAuto','Generated from the name when empty')}</p>`})
        +field(ctx,{path:'kind',id:'ar-kind',label:tx('alerts.rules.type','Type'),control:selectInput(ctx,'kind',kindOptions)})
      :builtin?fixed(tx('alerts.rules.name','Name'),ruleName(env,existing))
      :field(ctx,{path:'name',id:'ar-name',label:tx('alerts.rules.name','Name'),control:textInput(ctx,'name',{max:80})})+fixed(tx('alerts.rules.id','ID'),esc(shown(edit.id))))
      +(isNew?'':fixed(tx('alerts.rules.type','Type'),tx('alerts.rules.kind.'+kind,KIND_TEXT[kind])));
    const severity=field(ctx,{path:'severity',id:'ar-severity',label:tx('alerts.rules.severity','Severity'),control:selectInput(ctx,'severity',levelOptions(env,kind==='event'?[['auto',tx('alerts.rules.severityAuto','Same as event')]]:[]))});
    return `<form class="ar-form" novalidate aria-labelledby="ar-form-heading"><h3 class="ar-heading" id="ar-form-heading">${heading}</h3>${top}<div class="ar-fields">${common}${kindFields(ctx,kind)}${severity}`
      +intField(ctx,'forSweeps','forSweeps','forSweeps',2)+intField(ctx,'cooldownMinutes','cooldownMinutes','cooldown',4)
      +checkField(ctx,'enabled','enabled','Enabled')+checkField(ctx,'notify','notify','Notify')
      +`</div><div class="ar-actions"><button type="submit" class="al-btn ar-save"${ctx.dis}>${tx('alerts.rules.save','Save')}</button><button type="button" class="al-btn" data-rule-action="cancel"${ctx.dis}>${tx('alerts.rules.cancel','Cancel')}</button></div></form>`;
  }
  // The paths of the fields the form shows for a kind (where a server error can sit).
  function fieldNames(kind,isNew,builtin){
    const byKind={event:['params.minLevel','params.maxLevel','scope.kinds','scope.sources','scope.keywords','scope.radius.lat','scope.radius.lon','scope.radius.km'],threshold:['params.metric','params.op','params.value','params.clearValue'],change:['params.metric','params.pct'],
      absence:['params.source','params.minFailSweeps','params.maxAgeMinutes'],convergence:['params.cellDegrees','params.windowHours','params.minKinds','params.minLevel','params.kinds'],delta:['params.minSeverity']};
    return ['severity','forSweeps','cooldownMinutes','enabled','notify',...(builtin?[]:['name']),...(isNew?['id','kind']:[]),...byKind[kind]];
  }

  // ----- the list -----
  function ruleRow(env,rule,v){
    const {tx}=env,id=esc(rule.id),dis=v.busy===true?' disabled':'',name=ruleName(env,rule),sr=`<span class="ri-sr"> · ${name}</span>`;
    const source=SOURCES.includes(rule.source)?rule.source:'user',off=rule.enabled===false;
    const sev=rule.severity==='auto'?`<span class="ar-sev ar-sev-auto">${tx('alerts.rules.severityAuto','Same as event')}</span>`:`<span class="ar-sev"><span class="ri-glyph sev-${levelOf(rule.severity)}" aria-hidden="true">${GLYPH[levelOf(rule.severity)]||'–'}</span>${levelName(env,rule.severity)}</span>`;
    const toggle=(name2,label,fallback)=>`<label class="ar-toggle"><input type="checkbox" data-rule-toggle="${name2}" data-rule-id="${id}"${(name2==='enabled'?!off:rule.notify===true)?' checked':''}${dis}><span>${tx('alerts.rules.'+label,fallback)}${sr}</span></label>`;
    const asking=v.confirm===rule.id;
    const edit=`<button type="button" class="al-btn" data-rule-action="edit" data-rule-id="${id}"${dis}>${tx('alerts.rules.edit','Edit')}${sr}</button>`;
    const danger=source==='override'?`<button type="button" class="al-btn" data-rule-action="reset" data-rule-id="${id}"${dis}>${tx('alerts.rules.reset','Reset to default')}${sr}</button>`
      :source!=='user'?'':asking?`<span class="ar-confirm" role="group" aria-label="${tx('alerts.rules.confirmDelete','Delete this rule?')}"><span>${tx('alerts.rules.confirmDelete','Delete this rule?')}</span><button type="button" class="al-btn ar-danger" data-rule-action="delete-confirm" data-rule-id="${id}"${dis}>${tx('alerts.rules.delete','Delete')}${sr}</button><button type="button" class="al-btn" data-rule-action="cancel-confirm" data-rule-id="${id}"${dis}>${tx('alerts.rules.cancel','Cancel')}</button></span>`
      :`<button type="button" class="al-btn" data-rule-action="delete" data-rule-id="${id}"${dis}>${tx('alerts.rules.delete','Delete')}${sr}</button>`;
    return `<li class="ar-rule${off?' ar-rule-off':''}" data-rule-id="${id}"><div class="ar-rule-top"><span class="ar-rule-name">${name}</span><span class="ar-badge ar-kind-badge">${KINDS.includes(rule.kind)?tx('alerts.rules.kind.'+rule.kind,KIND_TEXT[rule.kind]):esc(shown(rule.kind))}</span><span class="ar-badge ar-source ar-source-${source}">${tx('alerts.rules.source.'+source,SOURCE_TEXT[source])}</span></div>`
      +`<p class="ar-summary">${describe(env,rule)}</p><div class="ar-rule-line">${sev}${toggle('enabled','enabled','Enabled')}${toggle('notify','notify','Notify')}<span class="ar-rule-actions">${edit}${danger}</span></div></li>`;
  }

  /** The content of the tray's Rules tab. view = {rules, metrics, editing: null|{id: string|null, draft, error: {field, message}|null},
   *  busy, loaded (default true), loadFailed, readOnly, confirm: rule id, notice: {key, fallback, detail}, status: {key, fallback}}. */
  function renderRules(view,t){
    const v=obj(view)||{loaded:false},env=speak(t);
    env.catalog=catalogOf(v.metrics);
    const tx=env.tx,busy=v.busy===true,rules=items(v.rules).filter(rule=>text(rule.id)),dis=busy?' disabled':'';
    const wrap=(heading,body)=>`<section class="ar-panel" aria-labelledby="${heading}" aria-busy="${busy}">${body}</section>`;
    const head=`<header class="ar-head"><h3 class="ar-heading" id="ar-heading">${tx('alerts.rules.title','Rules')}</h3>`;
    if(v.readOnly===true)return wrap('ar-heading',`${head}</header><p class="at-empty">${tx('alerts.rules.unavailable','Rules are only available on the live dashboard')}</p>`);
    const message=obj(v.notice)?`<p class="al-notice ar-notice" tabindex="-1">${tx(text(v.notice.key),text(v.notice.fallback))}${text(v.notice.detail)?`: ${esc(v.notice.detail)}`:''}</p>`:'';
    const status=obj(v.status)?`<p class="ar-status">${tx(text(v.status.key),text(v.status.fallback))}</p>`:'';
    const failed=v.loadFailed===true?`<p class="al-notice ar-notice" tabindex="-1">${tx('alerts.rules.errorLoad','Could not load the rules')}</p>`:'';
    if(v.loaded===false)return wrap('ar-heading',`${head}</header>${failed||`<p class="at-empty" role="status">${tx('alerts.rules.loading','Loading rules…')}</p>`}${failed?`<button type="button" class="al-btn" data-rule-action="retry">${tx('alerts.rules.retry','Retry')}</button>`:''}`);
    if(obj(v.editing))return wrap('ar-form-heading',form(env,v,rules));
    const list=rules.length?`<ul class="ar-list">${rules.map(rule=>ruleRow(env,rule,v)).join('')}</ul>`:`<p class="at-empty">${tx('alerts.empty','Nothing here')}</p>`;
    return wrap('ar-heading',`${head}<button type="button" class="al-btn" data-rule-action="new"${dis}>${tx('alerts.rules.add','New rule')}</button></header>${message}${failed}${status}${list}`);
  }
  // ===== End render =====

  // ===== Controller =====
  // Thin DOM layer on the tray (alerts.js calls attach once, activate when the Rules tab opens, view() for every redraw of it).
  // State lives here, the markup is a function of it, so a redraw of the tray (a live update) never loses an open form: every
  // input is copied into the draft as it is typed. One request at a time; the controls are disabled while it runs and the focus
  // is put back where the person was. Requests go through CrucixAlerts.request (same origin, JSON on every change).
  let opts={},root=null,live=null,rules=[],metrics=[],loaded=false,loadFailed=false,editing=null,confirming='',notice=null,status=null,busy=false,readOnly=false,loadSeq=0,speakTimer=0;
  const log=error=>{try{console.error('[alert-rules]',error);}catch{}};
  const guarded=fn=>(...args)=>{try{return fn(...args);}catch(error){log(error);}};
  const say=(key,fallback)=>speak(opts.t).raw(key,fallback);
  const attr=(node,name)=>node?.getAttribute?.(name)||'';
  const inRules=node=>!!node?.closest?.('.at-rules');
  const redraw=()=>{try{opts.redraw?.();}catch(error){log(error);}};
  const url=id=>'/api/alerts/rules/'+encodeURIComponent(id);
  const call=(path,body,method)=>{const A=window.CrucixAlerts;return typeof A?.request==='function'?A.request(path,body,method):Promise.reject(new Error('Alerts unavailable'));};
  const find=id=>rules.find(rule=>rule.id===id);
  const currentView=()=>({rules,metrics,editing,confirm:confirming,busy,loaded,loadFailed,readOnly,notice,status});
  // Focus a control after the redraw (the tray's own redraw restores the focus it finds; the controls of a request are disabled).
  function focus(selector){try{root?.querySelector?.(selector)?.focus?.();}catch(error){log(error);}}
  const rowSelector=(action,id)=>`[data-rule-action="${action}"][data-rule-id="${CSS.escape(id)}"]`;
  const toggleSelector=(flagName,id)=>`[data-rule-toggle="${flagName}"][data-rule-id="${CSS.escape(id)}"]`;
  // A message for screen readers through the persistent status node (emptied first, so the same words twice are spoken twice).
  function announce(message){
    if(!live)return;
    live.textContent='';clearTimeout(speakTimer);
    speakTimer=setTimeout(()=>{live.textContent=message;},50);
  }
  // A change that went through: the rule list takes the answer; the strip takes the summary (a disabled rule closes its alerts).
  function applied(data){
    try{window.CrucixAlerts?.update?.(data.summary);}catch(error){log(error);}
  }
  const withRule=rule=>{const next=rules.slice(),index=next.findIndex(item=>item.id===rule.id);if(index<0)next.push(rule);else next[index]=rule;return next;};
  // A refusal of the origin check (the page is open at an address the server takes no changes from) names the fix instead.
  const ORIGIN_CODES=['CROSS_ORIGIN','HOST_NOT_ALLOWED'];
  const reason=error=>ORIGIN_CODES.includes(text(error?.code))
    ?{field:'',message:say('alerts.errorOrigin','Refused at this address: open the dashboard at its ALERT_PUBLIC_URL address, or set ALERT_PUBLIC_URL or ALERT_ALLOWED_HOSTS on the server')}
    :{field:text(error?.field),message:text(error?.detail)};

  async function load(){
    if(readOnly)return;
    const seq=++loadSeq;
    try{
      const data=await call('/api/alerts/rules');
      if(!Array.isArray(data.rules)||!Array.isArray(data.metrics))throw new Error('No rule list');
      if(seq!==loadSeq)return;
      rules=items(data.rules).filter(rule=>RULE_ID.test(text(rule.id)));metrics=items(data.metrics);loaded=true;loadFailed=false;
    }catch(error){
      if(seq!==loadSeq)return;
      loadFailed=true;
    }
    redraw();
  }
  // One request at a time: the controls are off while `work` runs, `failure` shows what went wrong, `after` places the focus.
  async function run(work,failure,after){
    if(busy)return;
    busy=true;notice=null;status=null;redraw();
    try{
      await work();
      busy=false;
    }catch(error){
      busy=false;
      failure(error);
    }
    redraw();after?.();
  }

  async function save(){
    if(!editing||busy)return;
    const isNew=editing.id===null,existing=isNew?null:find(editing.id),draft=editing.draft;
    const taken=new Set(rules.map(rule=>rule.id));
    const id=isNew?(text(own(draft,'id')).trim()||uniqueId(slug(own(draft,'name')),taken)):editing.id;
    if(isNew&&taken.has(id)){editing.error={field:'id',message:say('alerts.rules.errorIdTaken','This ID is already used by another rule')};redraw();focus('#ar-id');return;}
    let body=parseDraft(draft);
    if(existing&&existing.source!=='user')body=pick(body,OVERRIDE_FIELDS);
    else if(!isNew)body=pick(body,USER_FIELDS);
    editing.error=null;
    await run(async()=>{
      const data=await call(url(id),body,'PUT'),rule=obj(data.rule);
      if(!rule||rule.id!==id)throw new Error('No rule in the answer');
      rules=withRule(rule);editing=null;status={key:'alerts.rules.saved',fallback:'Rule saved'};
      applied(data);announce(say('alerts.rules.saved','Rule saved'));
    },error=>{
      const why=reason(error);
      if(editing)editing.error=why;
      announce(say('alerts.rules.errorSave','Could not save the rule')+(why.message?': '+why.message:''));
    },()=>{
      if(editing)focus(editing.error&&editing.error.field?`[data-rule-field="${CSS.escape(editing.error.field.replace(/\[\d+\]/g,''))}"] :is(input,select)`:'.ar-notice');
      else focus(rowSelector('edit',id));
    });
  }
  async function flip(id,flagName,value){
    const rule=find(id);
    if(!rule)return;
    const base=rule.source==='user'?pick(rule,USER_FIELDS):pick(rule,OVERRIDE_FIELDS);
    await run(async()=>{
      const data=await call(url(id),{...base,[flagName]:value},'PUT'),next=obj(data.rule);
      if(!next||next.id!==id)throw new Error('No rule in the answer');
      rules=withRule(next);applied(data);
    },error=>{
      notice={key:'alerts.rules.errorSave',fallback:'Could not save the rule',detail:reason(error).message};
      announce(say('alerts.rules.errorSave','Could not save the rule'));
    },()=>focus(toggleSelector(flagName,id)));
  }
  // Delete a user rule, or reset a built-in's override (the list is read again: the default comes back from the server).
  async function remove(id,reset){
    if(!find(id))return;
    confirming='';
    await run(async()=>{
      const data=await call(url(id),undefined,'DELETE');
      if(reset)await load();else rules=rules.filter(rule=>rule.id!==id);
      status={key:reset?'alerts.rules.resetDone':'alerts.rules.deleted',fallback:reset?'Rule reset to default':'Rule deleted'};
      applied(data);announce(say(status.key,status.fallback));
    },error=>{
      notice={key:'alerts.rules.errorDelete',fallback:'Could not delete the rule',detail:reason(error).message};
      announce(say('alerts.rules.errorDelete','Could not delete the rule'));
    },()=>focus(reset?rowSelector('edit',id):'[data-rule-action="new"]'));
  }

  // Back to the list: the focus goes to the row that was being edited (or asked about), else to "New rule".
  function cancel(){
    const edited=editing?editing.id:null,asked=confirming;
    editing=null;confirming='';
    redraw();
    if(asked)focus(rowSelector('delete',asked));
    else focus(edited?rowSelector('edit',edited):'[data-rule-action="new"]');
  }
  function onClick(event){
    const node=event.target?.closest?.('[data-rule-action]');
    if(!node||!inRules(node)||busy)return;
    const action=attr(node,'data-rule-action'),id=attr(node,'data-rule-id'),known=RULE_ID.test(id)&&!!find(id);
    if(action==='new'){editing={id:null,draft:newDraft('event',metrics),error:null};status=null;notice=null;redraw();focus('#ar-name');}
    else if(action==='edit'&&known){editing={id,draft:draftOf(find(id)),error:null};confirming='';status=null;notice=null;redraw();focus('.ar-form [name]');}
    else if(action==='cancel')cancel();
    else if(action==='delete'&&known){confirming=id;redraw();focus(rowSelector('delete-confirm',id));}
    else if(action==='cancel-confirm'&&known){confirming='';redraw();focus(rowSelector('delete',id));}
    else if(action==='delete-confirm'&&known)remove(id,false);
    else if(action==='reset'&&known)remove(id,true);
    else if(action==='preset-hungary'&&editing){Object.assign(editing.draft,HUNGARY);redraw();focus('[data-rule-action="preset-hungary"]');}
    else if(action==='retry')load();
  }
  // A change of a list checkbox saves at once; a change of a form field updates the draft.
  function onField(event){
    const target=event.target;
    if(!target||!inRules(target))return;
    const flagName=attr(target,'data-rule-toggle');
    if(flagName){
      const id=attr(target,'data-rule-id');
      if(event.type==='change'&&FLAGS.includes(flagName)&&RULE_ID.test(id)&&!busy)flip(id,flagName,target.checked===true);
      return;
    }
    const name=attr(target,'name');
    if(!editing||!DRAFT_KEYS.includes(name)||!target.closest?.('.ar-form'))return;
    const draft=editing.draft;
    if(name==='kinds'){
      const token=attr(target,'value'),list=tokens(draft.kinds).filter(item=>item!==token);
      draft.kinds=target.checked===true?[...list,token]:list;
    }else if(target.type==='checkbox')draft[name]=target.checked===true;
    else draft[name]=asText(target.value);
    // The kind decides the fields, the metric the "current" hint: those two redraw.
    if(event.type==='change'&&name==='kind'&&editing.id===null){editing.draft={...newDraft(draft.kind,metrics),...pick(draft,['name','id','enabled','notify'])};redraw();focus('#ar-kind');}
    else if(event.type==='change'&&name==='metric'){redraw();focus('#ar-metric');}
  }
  function onSubmit(event){
    if(!inRules(event.target))return;
    event.preventDefault?.();
    save();
  }
  // Esc closes an open form (or the delete question) first; the tray's own Esc comes after (this listener runs first). While a
  // request runs Esc is taken and does nothing: the form, the question and the tray wait for the answer.
  function onKey(event){
    if(event.key!=='Escape'||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||!inRules(event.target))return;
    if(busy){event.preventDefault();return;}
    if(!editing&&!confirming)return;
    event.preventDefault();
    cancel();
  }

  function attach(options){
    if(root)return;
    try{
      const o=obj(options);
      if(!o||!o.root)return;
      opts=o;root=o.root;readOnly=o.readOnly===true;
      live=document.createElement('p');live.id='alertRulesLive';live.className='ri-sr';live.setAttribute('role','status');live.setAttribute('aria-live','polite');
      document.body.append(live);
      root.addEventListener('click',guarded(onClick));
      root.addEventListener('change',guarded(onField));root.addEventListener('input',guarded(onField));
      root.addEventListener('submit',guarded(onSubmit));
      root.addEventListener('keydown',guarded(onKey),true);
    }catch(error){log(error);}
  }
  // The Rules tab was opened: (re)read the rules and the metric values.
  function activate(){if(root&&!readOnly&&!busy)guarded(load)();}
  // ===== End controller =====

  window.CrucixAlertRules={renderRules,parseDraft,draftOf,newDraft,slug,attach,activate,view:currentView};
})(window);
