// Spawned server regression tests must not contact live upstreams or use real keys.
globalThis.fetch = async () => { throw new Error('External network disabled in server test'); };
globalThis.WebSocket = class { constructor() { throw new Error('External network disabled in server test'); } };
