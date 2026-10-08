import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing, flagUrgent } from '../apis/sources/telegram.mjs';

test('command bot token never causes private message collection', async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldEnabled = process.env.TELEGRAM_OSINT_ENABLED;
  let calls = 0;
  process.env.TELEGRAM_BOT_TOKEN = 'private-command-bot';
  process.env.TELEGRAM_OSINT_ENABLED = 'false';
  globalThis.fetch = async () => { calls++; throw new Error('must not request bot updates'); };
  try {
    const data = await briefing();
    assert.equal(calls, 0);
    assert.equal(data.status, 'disabled');
    assert.deepEqual(data.topPosts, []);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of [['TELEGRAM_BOT_TOKEN', oldToken], ['TELEGRAM_OSINT_ENABLED', oldEnabled]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('enabled public channel collection scrapes previews and reports web_scrape', async () => {
  const oldFetch = globalThis.fetch;
  const oldSetTimeout = globalThis.setTimeout;
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldEnabled = process.env.TELEGRAM_OSINT_ENABLED;
  const urls = [];
  process.env.TELEGRAM_BOT_TOKEN = 'private-command-bot';
  process.env.TELEGRAM_OSINT_ENABLED = 'true';
  // Skip the polite inter-batch delay so the test stays fast.
  globalThis.setTimeout = (fn, _ms, ...args) => oldSetTimeout(fn, 0, ...args);
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const channel = String(url).split('/').pop();
    const html = `<html><title>${channel}</title><div class="tgme_widget_message_wrap">`
      + `<div data-post="${channel}/1"><div class="tgme_widget_message_text">Breaking: missile strike reported</div>`
      + `<span class="tgme_widget_message_views">1.2K</span><time datetime="2026-10-08T00:00:00Z"></time></div></div></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const data = await briefing();
    assert.equal(data.status, 'web_scrape');
    assert.equal(data.hint, undefined);
    assert.ok(urls.length > 0);
    assert.ok(urls.every(u => u.startsWith('https://t.me/s/')), 'only public previews are fetched');
    assert.equal(data.channelsReachable, data.channelsMonitored);
    assert.ok(data.totalPosts > 0);
    assert.ok(data.urgentPosts.length > 0);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.setTimeout = oldSetTimeout;
    for (const [key, value] of [['TELEGRAM_BOT_TOKEN', oldToken], ['TELEGRAM_OSINT_ENABLED', oldEnabled]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('urgent keyword matching does not turn ordinary word substrings into alerts', () => {
  assert.equal(flagUrgent({ text: 'Unconfirmed rumor' }), null);
  assert.ok(flagUrgent({ text: 'Breaking news: missile launch' }).includes('breaking'));
});
