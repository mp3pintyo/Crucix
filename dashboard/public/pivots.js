(function(window){
  'use strict';
  // Pivot links: "look this up elsewhere". An entity found in a record (CVE id, public IPv4, crypto address, domain, LEI) becomes a few
  // links to well-known public lookup pages. Nothing is fetched: the browser only opens a page when the user clicks, so there is no key,
  // no quota and no data leaves the dashboard before that. Templates come from the awesome-osint-arsenal catalogue (see docs/releases/v2.14.0.md).
  // Pure functions, no DOM; the inspector escapes and renders the result.
  const TEMPLATES={
    cve:[['NVD','https://nvd.nist.gov/vuln/detail/{v}'],['CVE.org','https://www.cve.org/CVERecord?id={v}']],
    ip:[['VirusTotal','https://www.virustotal.com/gui/ip-address/{v}'],['AbuseIPDB','https://www.abuseipdb.com/check/{v}'],['GreyNoise','https://viz.greynoise.io/ip/{v}'],['Shodan','https://www.shodan.io/host/{v}']],
    domain:[['VirusTotal','https://www.virustotal.com/gui/domain/{v}'],['urlscan','https://urlscan.io/domain/{v}'],['crt.sh','https://crt.sh/?q={v}']],
    eth:[['Etherscan','https://etherscan.io/address/{v}'],['Blockchair','https://blockchair.com/ethereum/address/{v}']],
    btc:[['Blockchair','https://blockchair.com/bitcoin/address/{v}'],['WalletExplorer','https://www.walletexplorer.com/address/{v}']],
    lei:[['GLEIF','https://search.gleif.org/#/record/{v}']],
  };
  const MAX_TEXT=2000,MAX_ENTITIES=6;
  const CVE=/\bCVE-\d{4}-\d{4,7}\b/gi,IPV4=/(?:^|[^\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.]*\d)/g,ETH=/\b0x[0-9a-fA-F]{40}\b/g;
  const BTC=/\b(?:bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,DOMAIN=/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i,LEI=/^[0-9A-Z]{18}[0-9]{2}$/;
  // Public means a routable unicast address: private, loopback, link-local, CGNAT, multicast and reserved ranges are not looked up.
  function publicIp(value){
    const part=value.split('.').map(Number);
    if(part.length!==4||part.some((n,i)=>!Number.isInteger(n)||n<0||n>255||String(n)!==value.split('.')[i]))return false;
    const [a,b]=part;
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===192&&b===0)||(a===198&&(b===18||b===19)));
  }
  // A bitcoin address must mix digits and letters: a plain word of 26+ letters is not one.
  const looksBtc=value=>/\d/.test(value)&&/[a-zA-Z]/.test(value);
  const add=(found,type,value)=>{if(found.length<MAX_ENTITIES&&!found.some(e=>e.type===type&&e.value===value))found.push({type,value});};

  // Entities of a record: free text (title, summary, fact values) is scanned for CVEs, public IPv4 addresses and crypto addresses; a domain or a
  // LEI counts only when a fact is labelled so (a bare word in a title is never taken for one).
  function entitiesOf(record){
    const found=[];
    if(!record||typeof record!=='object')return found;
    const facts=Array.isArray(record.facts)?record.facts.slice(0,40):[];
    const texts=[record.title,record.summary,...facts.map(f=>f&&typeof f.value==='string'?f.value:'')].filter(v=>typeof v==='string').map(v=>v.slice(0,MAX_TEXT));
    for(const raw of texts){
      for(const m of raw.matchAll(CVE))add(found,'cve',m[0].toUpperCase());
      for(const m of raw.matchAll(IPV4))if(publicIp(m[1]))add(found,'ip',m[1]);
      for(const m of raw.matchAll(ETH))add(found,'eth',m[0]);
      for(const m of raw.matchAll(BTC))if(looksBtc(m[0]))add(found,'btc',m[0]);
    }
    for(const fact of facts){
      const label=typeof fact?.label==='string'?fact.label.toLowerCase():'',value=typeof fact?.value==='string'?fact.value.trim().slice(0,260):'';
      if(!value)continue;
      if(['domain','host','hostname','ioc domain'].includes(label)&&DOMAIN.test(value))add(found,'domain',value.toLowerCase());
      else if(label==='lei'&&LEI.test(value.toUpperCase()))add(found,'lei',value.toUpperCase());
    }
    return found;
  }

  // [{type, value, links:[{name, url}]}] for a record; every value is percent-encoded into its template.
  function pivotsFor(record){
    return entitiesOf(record).map(entity=>({...entity,links:TEMPLATES[entity.type].map(([name,url])=>({name,url:url.replace('{v}',encodeURIComponent(entity.value))}))}));
  }

  window.CrucixPivots={TEMPLATES,entitiesOf,pivotsFor,publicIp};
})(window);
