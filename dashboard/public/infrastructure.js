(function(window){
  'use strict';
  // Static infrastructure for the map: oil and gas pipelines and military bases, one JSON file (data/infrastructure.json, built from the
  // World Monitor datasets, see its `sources`). Loaded on demand when a layer is switched on; every field is checked and cut here, so a damaged
  // file draws nothing instead of breaking the page. Pipelines have only their two end points: lines are great circles between them, not routes.
  //   load(fetchJson?)  -> Promise<{pipelines, bases, sources}|null>   (one request; a failure is remembered for the page's life)
  //   get()             the loaded dataset or null
  //   greatCircle(a, b, steps)  [[lat, lon], ...] along the great circle
  //   distanceKm(lat1, lon1, lat2, lon2), nearby(lat, lon, km, limit)  -> { pipelines: [{item, km}], bases: [{item, km}] }
  //   pipelineText(p, say), baseText(b, say)  plain text for a popup; say(key, fallback, values) is the page's translator
  const URL_PATH='data/infrastructure.json',EARTH_KM=6371.0088,RAD=Math.PI/180;
  const STATES=['flowing','reduced','offline','unknown'];
  let dataset=null,pending=null,failed=false;
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const point=(lat,lon)=>finite(lat)&&finite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180;
  const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
  const code=value=>/^[A-Z]{2,3}$/.test(value)?value:'';

  function cleanPipeline(row){
    if(!row||typeof row!=='object'||!Array.isArray(row.p)||row.p.length!==4||!point(row.p[0],row.p[1])||!point(row.p[2],row.p[3]))return null;
    const kind=row.c==='g'?'g':row.c==='o'?'o':'';
    if(!kind||!text(row.n,90))return null;
    return {id:text(row.id,60),name:text(row.n,90),operator:text(row.o,90),kind,from:code(row.a),to:code(row.b),
      via:(Array.isArray(row.v)?row.v:[]).slice(0,8).map(code).filter(Boolean),capacity:finite(row.k)?row.k:null,length:finite(row.l)?row.l:null,since:Number.isInteger(row.y)?row.y:null,
      state:STATES.includes(row.ps)?row.ps:'unknown',statement:text(row.s,220),statementDate:/^\d{4}-\d{2}-\d{2}$/.test(row.sd||'')?row.sd:'',sanctions:Number.isInteger(row.sr)?row.sr:0,
      line:[row.p[0],row.p[1],row.p[2],row.p[3]]};
  }
  function cleanBase(row){
    if(!row||typeof row!=='object'||!point(row.lat,row.lon)||!text(row.n,90))return null;
    return {id:text(row.id,60),name:text(row.n,90),lat:row.lat,lon:row.lon,family:text(row.f,20),country:text(row.c,60),arm:text(row.arm,60),status:text(row.st,20),note:text(row.d,200)};
  }
  function parse(doc){
    if(!doc||typeof doc!=='object'||!Array.isArray(doc.pipelines)||!Array.isArray(doc.bases)||doc.pipelines.length>5000||doc.bases.length>5000)return null;
    const sources=doc.sources&&typeof doc.sources==='object'?{pipelines:text(doc.sources.pipelines,600),bases:text(doc.sources.bases,600)}:{pipelines:'',bases:''};
    return {pipelines:doc.pipelines.map(cleanPipeline).filter(Boolean),bases:doc.bases.map(cleanBase).filter(Boolean),sources};
  }
  function load(fetchJson){
    if(dataset)return Promise.resolve(dataset);
    if(failed)return Promise.resolve(null);
    if(!pending){
      const get=typeof fetchJson==='function'?fetchJson:url=>window.fetch(url,{credentials:'same-origin'}).then(response=>{if(!response.ok)throw new Error('HTTP '+response.status);return response.json();});
      pending=Promise.resolve().then(()=>get(URL_PATH)).then(doc=>{dataset=parse(doc);if(!dataset)failed=true;return dataset;},()=>{failed=true;return null;});
    }
    return pending;
  }
  // Great circle between two points as `steps`+1 [lat, lon] pairs (the points of a globe path or a flat-map line).
  function greatCircle(a,b,steps){
    const n=Math.max(1,Math.min(64,Math.round(steps||24)));
    const [lat1,lon1]=[a[0]*RAD,a[1]*RAD],[lat2,lon2]=[b[0]*RAD,b[1]*RAD];
    const d=2*Math.asin(Math.sqrt(Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin((lon2-lon1)/2)**2));
    if(!(d>1e-9))return [[a[0],a[1]],[b[0],b[1]]];
    const out=[];
    for(let i=0;i<=n;i++){
      const f=i/n,A=Math.sin((1-f)*d)/Math.sin(d),B=Math.sin(f*d)/Math.sin(d);
      const x=A*Math.cos(lat1)*Math.cos(lon1)+B*Math.cos(lat2)*Math.cos(lon2),y=A*Math.cos(lat1)*Math.sin(lon1)+B*Math.cos(lat2)*Math.sin(lon2),z=A*Math.sin(lat1)+B*Math.sin(lat2);
      out.push([Math.atan2(z,Math.sqrt(x*x+y*y))/RAD,Math.atan2(y,x)/RAD]);
    }
    return out;
  }
  function distanceKm(lat1,lon1,lat2,lon2){
    const p1=lat1*RAD,p2=lat2*RAD,a=Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin((lon2-lon1)*RAD/2)**2;
    return 2*EARTH_KM*Math.asin(Math.min(1,Math.sqrt(a)));
  }
  const bearing=(lat1,lon1,lat2,lon2)=>{const p1=lat1*RAD,p2=lat2*RAD,dl=(lon2-lon1)*RAD;return Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl));};
  // Distance from a point to the great-circle SEGMENT between the end points (cross-track inside the segment, the nearer end point outside it).
  function distanceToLineKm(lat,lon,line){
    const [la,lo,lb,lob]=line,d12=distanceKm(la,lo,lb,lob),d13=distanceKm(la,lo,lat,lon);
    if(d12<1e-6||d13<1e-6)return Math.min(d13,distanceKm(lb,lob,lat,lon));
    const t13=bearing(la,lo,lat,lon),t12=bearing(la,lo,lb,lob);
    const xt=Math.asin(Math.sin(d13/EARTH_KM)*Math.sin(t13-t12))*EARTH_KM;
    const along=Math.acos(Math.max(-1,Math.min(1,Math.cos(d13/EARTH_KM)/Math.cos(xt/EARTH_KM))))*EARTH_KM;
    const forward=Math.cos(t13-t12)>=0;
    if(!forward)return d13;
    if(along>d12)return distanceKm(lb,lob,lat,lon);
    return Math.abs(xt);
  }
  // Pipelines and bases within `km` of a point, nearest first, at most `limit` of each.
  function nearby(lat,lon,km,limit){
    const out={pipelines:[],bases:[]};
    if(!dataset||!point(lat,lon)||!finite(km)||km<=0)return out;
    const cap=Math.max(1,Math.min(50,Math.round(limit||5)));
    for(const item of dataset.pipelines){const d=distanceToLineKm(lat,lon,item.line);if(d<=km)out.pipelines.push({item,km:Math.round(d)});}
    for(const item of dataset.bases){const d=distanceKm(lat,lon,item.lat,item.lon);if(d<=km)out.bases.push({item,km:Math.round(d)});}
    out.pipelines.sort((a,b)=>a.km-b.km||(a.item.id<b.item.id?-1:1));out.bases.sort((a,b)=>a.km-b.km||(a.item.id<b.item.id?-1:1));
    out.pipelines.length=Math.min(out.pipelines.length,cap);out.bases.length=Math.min(out.bases.length,cap);
    return out;
  }
  const fill=(template,values)=>{let out=template;for(const [key,value] of Object.entries(values||{}))out=out.split('{'+key+'}').join(String(value));return out;};
  function say(translate,key,fallback,values){let template=fallback;try{if(typeof translate==='function'){const got=translate('infra.'+key,fallback);if(typeof got==='string'&&got)template=got;}}catch{}return fill(template,values);}
  function pipelineText(p,translate){
    const lines=[];
    const route=p.from&&p.to?say(translate,'route','From {a} to {b}',{a:p.from,b:p.to}):'';
    if(route)lines.push(route+(p.via.length?' · '+say(translate,'via','via {list}',{list:p.via.join(', ')}):''));
    if(p.operator)lines.push(p.operator);
    if(p.capacity!==null)lines.push(p.kind==='o'?say(translate,'capacityOil','Capacity {k} million barrels a day',{k:p.capacity}):say(translate,'capacityGas','Capacity {k} billion cubic metres a year',{k:p.capacity}));
    const facts=[p.length!==null?say(translate,'length','Length {l} km',{l:p.length}):'',p.since!==null?say(translate,'since','in service since {y}',{y:p.since}):''].filter(Boolean);
    if(facts.length)lines.push(facts.join(' · '));
    if(p.statement)lines.push(p.statement+(p.statementDate?' ('+p.statementDate+')':''));
    if(p.sanctions)lines.push(say(translate,'sanctions','{n} sanction references on record',{n:p.sanctions}));
    lines.push(say(translate,'lineNote','Drawn as the great circle between the end points, not the physical route.'));
    return lines.join('\n');
  }
  function baseText(b,translate){
    const lines=[];
    const family=say(translate,'family_'+b.family,b.family||'—');
    lines.push([family,b.country].filter(Boolean).join(' · '));
    if(b.arm)lines.push(b.arm);
    if(b.note)lines.push(b.note);
    lines.push(say(translate,'baseNote','A public-source compilation; it is not a statement about the current garrison.'));
    return lines.join('\n');
  }
  window.CrucixInfrastructure={load,get:()=>dataset,parse,greatCircle,distanceKm,distanceToLineKm,nearby,pipelineText,baseText,
    reset:()=>{dataset=null;pending=null;failed=false;}};
})(window);
