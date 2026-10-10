(function (window, document) {
  'use strict';
  const DB = 'crucix-offline-v1', MAX_BYTES = 5 * 1024 * 1024;
  const KEYS = ['meta','air','airMeta','thermal','tSignals','chokepoints','aisVessels','nuke','nukeSignals','sdr','earthquakes','ioda','tg','who','supplementalHealth','fred','energy','metals','bls','treasury','gscpi','defense','noaa','epa','acled','gdelt','space','health','news','markets','ideas','ideasSource','ideasCached','delta','newsFeed','events','liveSources','alerts','changes','risk'];
  let options = {}, enabled = false, storedAt = null, cachedView = false, error = '', registration = null, installPrompt = null, initialized = false;
  const t = (key, fallback) => options.t?.('pwa.' + key, fallback) || fallback;
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('Browser storage unavailable'));
      const request = window.indexedDB.open(DB, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state'); };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error || new Error('Browser storage unavailable'));
      request.onblocked = () => reject(new Error('Browser storage blocked'));
    });
  }
  async function transaction(mode, operation) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      let tx, store;
      try { tx=db.transaction('state', mode);store=tx.objectStore('state'); }
      catch(error) { db.close();reject(error);return; }
      let result;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Browser storage unavailable')); };
      try { operation(store, value => result = value); } catch (e) { tx.abort(); reject(e); }
    });
  }
  function safeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !snapshot.meta || typeof snapshot.meta.timestamp !== 'string' || !Number.isFinite(Date.parse(snapshot.meta.timestamp))) return null;
    if(Date.parse(snapshot.meta.timestamp)>Date.now()+300000)return null;
    const day=snapshot.meta.timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
    if(!day||new Date(day[1]+'T00:00:00Z').toISOString().slice(0,10)!==day[1])return null;
    for(const key of ['air','thermal','who','ideas','newsFeed','health','earthquakes','events','liveSources'])if(snapshot[key]!==undefined&&!Array.isArray(snapshot[key]))return null;
    const value = {};
    for (const key of KEYS) if (Object.hasOwn(snapshot, key)) value[key] = snapshot[key];
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > MAX_BYTES) throw new Error('Snapshot exceeds local storage limit');
    return JSON.parse(json);
  }
  // A sweep replay shows an archived snapshot: nothing is written while it is active (cacheLive, enabling, any caller).
  const replaying = () => { try { return !!window.CrucixReplay?.active?.(); } catch { return false; } };
  async function saveSnapshot(snapshot) {
    if (replaying()) return false;
    const value = safeSnapshot(snapshot); if (!value) return false;
    return transaction('readwrite', (store, result) => {
      const setting = store.get('enabled');
      setting.onsuccess = () => {
        if (setting.result !== true) { result(false); return; }
        const previous = store.get('snapshot');
        previous.onsuccess = () => {
          let prior=null;try{prior=safeSnapshot(previous.result?.data);}catch{ /* Replace unusable local data. */ }
          if (prior&&Date.parse(prior.meta.timestamp) > Date.parse(value.meta.timestamp)) { result(false); return; }
          const at = new Date().toISOString(); store.put({data:value,savedAt:at}, 'snapshot'); storedAt = at; result(true);
        };
      };
    });
  }
  async function restoreSnapshot() {
    return transaction('readonly', (store, result) => {
      const setting = store.get('enabled'); setting.onsuccess = () => {
        if (setting.result !== true) { result(null); return; }
        const request = store.get('snapshot'); request.onsuccess = () => {
          const saved = request.result; let data=null;try{data=safeSnapshot(saved?.data);}catch{ /* Ignore corrupt or oversized local data. */ }
          if (data) storedAt = saved.savedAt; result(data ? {data,savedAt:saved.savedAt} : null);
        };
      };
    });
  }
  async function clearSnapshot() {
    await transaction('readwrite', (store, result) => { store.put(false,'enabled');store.delete('snapshot');result(true); });
    enabled = false; storedAt = null; renderStatus(); return true;
  }
  async function setOfflineEnabled(value) {
    if (!value) return clearSnapshot();
    await transaction('readwrite', (store, result) => { store.put(true,'enabled');result(true); });
    enabled = true; await saveSnapshot(options.getSnapshot?.()); renderStatus(); return true;
  }
  function renderStatus() {
    const strip = document.querySelector('.status-strip'); if (!strip) return;
    let node = document.getElementById('pwaFreshness'); if (!node) { node=el('span');node.id='pwaFreshness';strip.append(node); }
    node.textContent = cachedView ? t('cached','Offline snapshot') + ' · ' + (options.getSnapshot?.()?.meta?.timestamp || t('unknown','Unknown time')) : '';
    node.dataset.offlineSnapshot = String(cachedView);
  }
  async function cacheLive(snapshot) {
    if (!enabled) return;
    try { await saveSnapshot(snapshot); error=''; } catch { error=t('storageError','Local snapshot storage unavailable.'); }
  }
  function markLive() { cachedView=false;renderStatus(); }
  function button(label, action, id) {
    const node=el('button',label);node.type='button';node.className='guide-btn';if(id)node.id=id;
    node.onclick=()=>Promise.resolve().then(action).catch(()=>{error=t('storageError','Local snapshot storage unavailable.');const message=document.getElementById('pwa-message');if(message)message.textContent=error;});return node;
  }
  function openSettings() {
    if (document.getElementById('pwa-dialog')) return;
    const dialog=el('dialog');dialog.id='pwa-dialog';dialog.className='ci-dialog pwa-dialog';dialog.setAttribute('aria-labelledby','pwa-title');
    const title=el('h2',t('title','Install and offline access'));title.id='pwa-title';dialog.append(title);
    dialog.append(el('p',t('help','Install from Chrome or Edge on localhost/HTTPS. The interface works offline; fresh collection and history search need the local server.')));
    const label=el('label');const input=el('input');input.type='checkbox';input.id='pwa-save-snapshot';input.checked=enabled;label.append(input,document.createTextNode(' '+t('save','Keep the last snapshot on this browser')));dialog.append(label);
    dialog.append(el('p',t('privacy','Off by default. Enabling stores the displayed intelligence on this browser until you clear it.')));
    const message=el('p',error || (storedAt ? t('saved','Last local save')+' · '+storedAt : t('empty','No local snapshot saved.')));message.id='pwa-message';message.setAttribute('role','status');dialog.append(message);
    input.onchange=async()=>{input.disabled=true;try{await setOfflineEnabled(input.checked);message.textContent=enabled?(replaying()?t('savedAfterReplay','Saving is on. The live snapshot is saved when you go back to live from the replay.'):t('saved','Snapshot saved locally.')):t('cleared','Local snapshot deleted.');}catch{input.checked=enabled;message.textContent=t('storageError','Local snapshot storage unavailable.');}finally{input.disabled=false;}};
    dialog.append(button(t('clear','Delete local snapshot'),async()=>{await clearSnapshot();input.checked=false;message.textContent=t('cleared','Local snapshot deleted.');},'pwa-clear'));
    const install=button(t('install','Install app'),async()=>{await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;install.disabled=true;},'pwa-install');install.disabled=!installPrompt;dialog.append(install);
    if (!installPrompt) dialog.append(el('p',t('installHelp','Use your browser’s Install app menu when available. First open this address online.')));
    const update=button(t('update','Apply downloaded update'),()=>{const waiting=registration?.waiting;if(!waiting){update.disabled=true;message.textContent=t('noUpdate','No downloaded update is waiting.');return;}waiting.postMessage({type:'APPLY_UPDATE'});window.navigator.serviceWorker.addEventListener('controllerchange',()=>window.location.reload(),{once:true});},'pwa-update');update.disabled=!registration?.waiting;dialog.append(update);
    dialog.append(button(t('close','Close'),()=>dialog.close(),'pwa-close'));
    dialog.addEventListener('close',()=>{dialog.remove();document.getElementById('pwaTrigger')?.focus();});dialog.addEventListener('click',event=>{const rect=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))dialog.close();});
    document.body.append(dialog);dialog.showModal();
  }
  async function init(value) {
    options=value || {}; if (initialized) return; initialized=true;
    window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;const install=document.getElementById('pwa-install');if(install)install.disabled=false;});
    try {
      enabled=await transaction('readonly',(store,result)=>{const request=store.get('enabled');request.onsuccess=()=>result(request.result===true);});
      if (window.__CRUCIX_OFFLINE_SHELL__) {
        const saved=await restoreSnapshot();
        if(saved&&options.applySnapshot?.(saved.data)){cachedView=true;renderStatus();}
      } else if (enabled) await cacheLive(options.getSnapshot?.());
    } catch { error=t('storageError','Local snapshot storage unavailable.'); }
    if ('serviceWorker' in window.navigator && window.isSecureContext) {
      try {
        registration=await window.navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
        registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&registration.waiting){const update=document.getElementById('pwa-update');if(update)update.disabled=false;const message=document.getElementById('pwa-message');if(message)message.textContent=t('updateReady','An update is downloaded. Apply it when you are ready.');}});});
      }
      catch { error=t('shellError','Offline interface installation failed; reconnect and reload to retry.'); }
    }
    renderStatus();
  }
  window.CrucixPWA=Object.freeze({init,openSettings,saveSnapshot,restoreSnapshot,setOfflineEnabled,clearSnapshot,cacheLive,markLive,renderStatus});
})(window, document);
