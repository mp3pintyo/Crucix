// Bounded requests. Deadlines cover headers AND the complete response body.
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : null;
}

export async function readBoundedBytes(response, maxBytes = 10 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} byte limit`);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function readBoundedText(response, maxBytes = 10 * 1024 * 1024) {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

export async function safeFetch(url, opts = {}) {
  const { timeout = 15000, retries = 1, headers = {}, maxBytes = 10 * 1024 * 1024,
    format = 'json', method = 'GET', body, retryDelay = 2000, maxRetryDelay = 30000, retryAfterHeader = 'retry-after' } = opts;
  let lastError;
  let lastStatus;
  let lastRetryAfterMs = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let waitMs = retryDelay * (attempt + 1);
    let retryable = true;
    try {
      const response = await fetch(url, {
        signal: controller.signal, method, body,
        headers: { 'User-Agent': 'Crucix/2.2', ...headers },
      });
      lastStatus = response.status;
      if (!response.ok) {
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const requestedDelay = lastRetryAfterMs = retryAfterMs(response.headers.get(retryAfterHeader));
        if (requestedDelay !== null) {
          if (requestedDelay > maxRetryDelay) retryable = false;
          waitMs = requestedDelay;
        }
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`); // upstream bodies may echo credentials
      }
      if (format === 'buffer') return { rawBuffer: await readBoundedBytes(response, maxBytes) };
      const text = await readBoundedText(response, maxBytes);
      if (format === 'text') return { rawText: text };
      try { return JSON.parse(text); }
      catch { return { error: 'Invalid JSON response', status: response.status }; }
    } catch (error) {
      lastError = controller.signal.aborted ? new Error(`Request timed out after ${timeout}ms`) : error;
    } finally { clearTimeout(timer); }
    if (!retryable || attempt === retries) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(maxRetryDelay, waitMs)));
  }
  return { error: lastError?.message || 'Unknown error', ...(lastStatus ? { status: lastStatus } : {}),
    ...(lastRetryAfterMs !== null ? { retryAfterMs: lastRetryAfterMs } : {}) };
}

export function ago(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

export function today() {
  return new Date().toISOString().split('T')[0];
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
