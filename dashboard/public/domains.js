(function(window){
  'use strict';
  // Browser copy of lib/domains.mjs: the same eight domains and sources, in the same order (test/domains.test.mjs keeps them identical).
  const domain=(id,sources)=>Object.freeze({id,sources:Object.freeze(sources)});
  const DOMAINS=Object.freeze([
    domain('security',['GDELT','ACLED','ReliefWeb','ADSB-Military','ADSB-Orbits','ADS-B','OpenSky','Maritime','Telegram','Bluesky','Reddit','KiwiSDR','VIEWS-Forecast','INFORM-Risk','Travel-Advisories','GPSJam','UNHCR-Arrivals']),
    domain('hazards',['USGS','EMSC','GDACS','Copernicus-EMS','NASA-EONET','FIRMS','Meteoalarm','MET-Norway','Aviation-SIGMET','NOAA','WMO-SWIC','NOAA-NHC']),
    domain('space',['NOAA-SWPC','Space','Launch-Library']),
    domain('cyber',['CISA-KEV','FIRST-EPSS','OONI','IODA','Cloudflare-Radar','RIPEstat','ThreatFox','HIBP','SEC-8K','MISP-Galaxy']),
    domain('economy',['FRED','Treasury','BLS','ECB','YFinance','USAspending','Prediction-Markets','Patents']),
    domain('supply',['EIA','Energy-Charts-HU','ENTSOG-HU','IMF-PortWatch','GSCPI','Comtrade']),
    domain('sanctions',['OFAC','OpenSanctions','OpenSanctions-Index','Federal-Register']),
    domain('health',['WHO','EPA','Safecast'])
  ]);
  const DOMAIN_IDS=Object.freeze(DOMAINS.map(item=>item.id));
  const BY_SOURCE=new Map(DOMAINS.flatMap(item=>item.sources.map(source=>[source,item.id])));
  const domainOfSource=name=>typeof name==='string'?BY_SOURCE.get(name)??null:null;
  function domainOfEvent(event){
    if(event===null||typeof event!=='object')return null;
    const nested=event.source!==null&&typeof event.source==='object'?event.source.name:undefined;
    return domainOfSource(nested??event.sourceName);
  }
  window.CrucixDomains={DOMAINS,DOMAIN_IDS,domainOfSource,domainOfEvent};
})(window);
