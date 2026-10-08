(function(window){
  'use strict';
  // In-app data attribution: the credits and licences of what the page shows right now. The terms of several sources (OpenStreetMap/ODbL, CC BY,
  // NASA acknowledgement requests) ask for a visible credit while their data is displayed; this list is built from the map layers that are switched on,
  // the globe basemap, the static datasets that have been loaded, and the live sources of the snapshot (their own attribution and licence text).
  //   list({ layers, basemap, infrastructureLoaded, sitesLoaded, liveSources }) -> [{ id, group, name, text, license, url }]
  //   groups: 'map' (layers and basemap), 'data' (static datasets), 'live' (live sources), 'software'
  const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
  const https=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:''}catch{return ''}};
  const ODBL='ODbL 1.0',ODBL_URL='https://opendatacommons.org/licenses/odbl/1-0/';
  const entry=(id,group,name,body,license,url)=>({id,group,name,text:body,license:license||'',url:url||''});
  // Static credits. `layer` ties an entry to a map layer (shown while it is on, or once its dataset has been loaded for the record inspector).
  const STATIC=[
    {layer:'pipelines',data:'infrastructure',e:entry('pipelines','data','Oil and gas pipelines','Operator disclosures, regulator filings, ENTSOG and Global Energy Monitor (CC BY 4.0), as compiled by World Monitor (koala73/worldmonitor). Only the end points are known: the lines are great circles, not routes.','CC BY 4.0 (Global Energy Monitor)','https://creativecommons.org/licenses/by/4.0/')},
    {layer:'bases',data:'infrastructure',e:entry('bases','data','Military bases','Foreign and overseas military bases compiled by World Monitor from public sources. A base listed is not a statement about its garrison.','','https://github.com/koala73/worldmonitor')},
    {layer:'milareas',data:'sites',e:entry('milareas','data','Mapped military areas','© OpenStreetMap contributors, via the Overture Maps Foundation, compiled for God’s Eye View (MIT). Mapped areas, not a statement about use or garrison; incomplete by nature.',ODBL,ODBL_URL)},
    {layer:'datacenters',data:'sites',e:entry('datacenters','data','Data centres','© OpenStreetMap contributors, via God’s Eye View. Incomplete by nature.',ODBL,ODBL_URL)},
    {layer:'dams',data:'sites',e:entry('dams','data','Dams','© OpenStreetMap contributors and Open Infrastructure Map, via God’s Eye View. Incomplete by nature.',ODBL,ODBL_URL)},
  ];
  const BASEMAP_DAY=entry('basemap-day','map','Daily satellite image','We acknowledge the use of imagery provided by services from NASA’s Global Imagery Browse Services (GIBS), part of NASA’s Earth Science Data and Information System (ESDIS). VIIRS (NOAA-20) true colour, yesterday’s composite.','U.S. public domain (NASA)','https://gibs.earthdata.nasa.gov');
  const BASEMAP_NIGHT=entry('basemap-night','map','Night-lights globe texture','NASA Earth Observatory imagery, as bundled with three-globe (MIT).','','https://github.com/vasturiano/three-globe');
  const COUNTRIES=entry('countries','map','Country outlines','Natural Earth via world-atlas (public domain).','Public domain','https://www.naturalearthdata.com/');
  const SOFTWARE=entry('software','software','Software','globe.gl and three-globe (MIT), D3 and topojson-client (ISC), GSAP, IBM Plex Mono and Space Grotesk (OFL). Licence texts are in /vendor/licenses.','','');

  function list(ctx){
    const c=ctx&&typeof ctx==='object'?ctx:{};
    const layers=c.layers&&typeof c.layers==='object'?c.layers:{};
    const out=[];
    out.push(c.basemap==='day'?BASEMAP_DAY:BASEMAP_NIGHT,COUNTRIES);
    const loaded={infrastructure:c.infrastructureLoaded===true,sites:c.sitesLoaded===true};
    for(const item of STATIC)if(layers[item.layer]===true||loaded[item.data])out.push(item.e);
    const seen=new Set();
    for(const source of Array.isArray(c.liveSources)?c.liveSources.slice(0,100):[]){
      if(!source||typeof source!=='object')continue;
      const name=text(source.source,60),body=text(source.attribution,600);
      if(!name||!body||seen.has(name)||(source.status!=='ok'&&source.status!=='stale'))continue;
      seen.add(name);
      out.push(entry('live:'+name,'live',name,body,text(source.license,120),https(source.licenseUrl)||https(source.url)));
    }
    out.push(SOFTWARE);
    return out.map(item=>({...item,url:https(item.url)}));
  }
  const esc=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  // The panel body: one block per entry; names and texts are escaped, a link is only ever an https URL.
  function html(items,say){
    const tr=(key,fallback)=>{try{const got=typeof say==='function'?say('credits.'+key,fallback):fallback;return typeof got==='string'&&got?got:fallback}catch{return fallback}};
    const groups=[['map',tr('groupMap','Map and globe')],['data',tr('groupData','Static datasets')],['live',tr('groupLive','Live sources')],['software',tr('groupSoftware','Software')]];
    return groups.map(([id,label])=>{
      const rows=(items||[]).filter(item=>item.group===id);
      if(!rows.length)return '';
      return '<h4>'+esc(label)+'</h4><ul class="cr-list">'+rows.map(item=>'<li><strong>'+esc(item.name)+'</strong> '+esc(item.text)
        +(item.license?' <span class="cr-lic">'+(item.url?'<a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.license)+'</a>':esc(item.license))+'</span>':(item.url?' <a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(tr('source','source'))+'</a>':''))+'</li>').join('')+'</ul>';
    }).join('');
  }
  window.CrucixCredits={list,html};
})(window);
