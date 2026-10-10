import { WORLD_FEEDS } from '../apis/utils/news-feeds.mjs';
import { safeFetch } from '../apis/utils/fetch.mjs';
import { parseFeed } from '../apis/utils/rss.mjs';

const TIMEOUT_MS = 6000;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '40', 10);

async function fetchOne(f) {
  try {
    const res = await safeFetch(f.url, { timeout: TIMEOUT_MS, retries: 0, format: 'text', maxBytes: 1024 * 1024 });
    if (res.error) return { ok: false, source: f.source, error: res.error };
    const items = parseFeed(res.rawText);
    return { ok: true, source: f.source, country: f.country, count: items.length, sample: items[0]?.title };
  } catch (err) {
    return { ok: false, source: f.source, error: err.message };
  }
}

async function runBenchmark() {
  console.log(`[RSS Benchmark] Összes feed: ${WORLD_FEEDS.length}`);
  console.log(`[RSS Benchmark] Párhuzamosság (concurrency): ${CONCURRENCY}`);
  console.log(`[RSS Benchmark] Időtúllépés per feed (timeout): ${TIMEOUT_MS / 1000}s`);
  console.log(`[RSS Benchmark] Mérés indul...\n`);

  const startTime = Date.now();
  let done = 0;
  let success = 0;
  let failed = 0;
  let totalHeadlines = 0;

  const queue = [...WORLD_FEEDS];
  const workers = Array.from({ length: CONCURRENCY }, async (_, workerId) => {
    while (queue.length > 0) {
      const f = queue.shift();
      if (!f) break;
      const res = await fetchOne(f);
      done++;
      if (res.ok) {
        success++;
        totalHeadlines += res.count;
      } else {
        failed++;
      }
      if (done % 50 === 0 || done === WORLD_FEEDS.length) {
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`  -> Haladás: ${done}/${WORLD_FEEDS.length} feed kész (${success} OK, ${failed} hiba) - ${elapsedSec}s\r`);
      }
    }
  });

  await Promise.all(workers);
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\n\n================ TESZT EREDMÉNYE ================`);
  console.log(`Összes feed:              ${WORLD_FEEDS.length}`);
  console.log(`Sikeresen beolvasva:     ${success} (${((success / WORLD_FEEDS.length) * 100).toFixed(1)}%)`);
  console.log(`Időtúllépés / hiba:      ${failed}`);
  console.log(`Összes letöltött hír:    ${totalHeadlines} db friss hír`);
  console.log(`Teljes futási idő:       ${totalDuration} másodperc`);
  console.log(`Átlagos sebesség:        ${(WORLD_FEEDS.length / parseFloat(totalDuration)).toFixed(1)} feed / másodperc`);
  console.log(`=================================================`);
}

runBenchmark().catch(console.error);
