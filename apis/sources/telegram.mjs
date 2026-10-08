// Telegram — public channel intelligence from conflict zones and OSINT analysts
// Optional mode: public channel web previews at https://t.me/s/{channel}
// Explicit opt-in; the command bot token/update queue is never used here.
// Monitors conflict zones (Ukraine, Middle East), geopolitics, and OSINT channels.

import '../utils/env.mjs';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Curated list of well-known public OSINT / conflict / geopolitics channels
// All verified to have public web previews enabled at https://t.me/s/{id}
// Override with TELEGRAM_CHANNELS env var (comma-separated channel IDs)
const DEFAULT_CHANNELS = [
  // === Conflict: Ukraine/Russia ===
  { id: 'intelslava',        label: 'Intel Slava Z',       topic: 'conflict',    note: 'Conflict updates, pro-Russian perspective' },
  { id: 'legitimniy',        label: 'Legitimniy',          topic: 'conflict',    note: 'Ukrainian politics & conflict analysis' },
  { id: 'wartranslated',     label: 'War Translated',      topic: 'conflict',    note: 'Conflict translations & OSINT' },
  { id: 'ukraine_frontline', label: 'Ukraine Frontline',   topic: 'conflict',    note: 'Frontline situation updates' },
  { id: 'mod_russia',        label: 'Russian MoD',         topic: 'conflict',    note: 'Russian Ministry of Defense official' },
  { id: 'CIG_telegram',      label: 'Conflict Intel Team', topic: 'osint',       note: 'Conflict Intelligence Team analysis' },
  { id: 'RVvoenkor',         label: 'Voenkor RV',          topic: 'conflict',    note: 'Russian military correspondent' },
  { id: 'readovkanews',      label: 'Readovka',            topic: 'conflict',    note: 'Russian conflict news aggregator' },
  { id: 'DeepStateUA',       label: 'DeepState Ukraine',   topic: 'conflict',    note: 'Ukrainian frontline maps & analysis' },
  { id: 'operativnoZSU',     label: 'ZSU Operative',       topic: 'conflict',    note: 'Ukrainian armed forces updates' },
  { id: 'GeneralStaffZSU',   label: 'General Staff ZSU',   topic: 'conflict',    note: 'Ukrainian General Staff official' },
  // === Middle East ===
  { id: 'middleeastosint',   label: 'Middle East OSINT',   topic: 'osint',       note: 'Middle East open source intel' },
  { id: 'inikiforv',         label: 'Nikiforov OSINT',     topic: 'osint',       note: 'Cross-regional OSINT analyst' },
  // === Geopolitics & Analysis ===
  { id: 'geaborning',        label: 'Geo A. Borning',      topic: 'geopolitics', note: 'Geopolitical analysis and forecasting' },
  { id: 'TheIntelligencer',  label: 'The Intelligencer',   topic: 'osint',       note: 'Intelligence community news' },
  // === Markets & Finance ===
  { id: 'WallStreetSilver',  label: 'Wall St Silver',      topic: 'finance',     note: 'Commodities and macro commentary' },
  { id: 'unusual_whales',    label: 'Unusual Whales',      topic: 'finance',     note: 'Market flow and options analysis' },
];

// Allow user to add custom channels via env var
function loadChannels() {
  const custom = process.env.TELEGRAM_CHANNELS;
  if (!custom) return DEFAULT_CHANNELS;

  const customIds = custom.split(',').map(s => s.trim()).filter(Boolean);
  const existing = new Set(DEFAULT_CHANNELS.map(c => c.id));

  const extras = customIds
    .filter(id => !existing.has(id))
    .map(id => ({ id, label: id, topic: 'custom', note: 'User-added channel' }));

  return [...DEFAULT_CHANNELS, ...extras];
}

const CHANNELS = loadChannels();

// Urgent keywords that flag high-priority posts
// Organized by domain for maintainability
const URGENT_KEYWORDS = [
  // Breaking / meta urgency
  'breaking', 'urgent', 'alert', 'confirmed', 'just in', 'flash',
  // Military / kinetic
  'missile', 'strike', 'explosion', 'airstrike', 'drone', 'bombardment',
  'shelling', 'intercept', 'ICBM', 'hypersonic', 'F-16', 'ATACMS', 'HIMARS',
  // Escalation / de-escalation
  'nuclear', 'chemical', 'biological', 'ceasefire', 'escalation', 'invasion',
  'offensive', 'retreat', 'advance', 'mobilization', 'martial law',
  // Geopolitical
  'nato', 'coup', 'assassination', 'sanctions', 'embargo', 'blockade',
  'summit', 'ultimatum', 'declaration of war', 'peace deal',
  // Casualty / humanitarian
  'casualties', 'killed', 'wounded', 'evacuation', 'refugee', 'humanitarian',
  // Infrastructure / cyber
  'blackout', 'sabotage', 'cyberattack', 'pipeline', 'dam', 'nuclear plant',
  // Financial crisis
  'default', 'bank run', 'circuit breaker', 'flash crash', 'emergency rate',
];

// Public previews only: never consume the command bot update queue or private messages.

// ─── Web preview scraping fallback ──────────────────────────────────────────

// Fetch raw HTML from a URL (safeFetch truncates non-JSON to 500 chars, too short)
async function fetchHTML(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Crucix/2.1 public-channel-reader',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

// Parse messages from Telegram web preview HTML (https://t.me/s/channel)
// The HTML contains <div class="tgme_widget_message_wrap"> blocks with message content.
function parseWebPreview(html, channelId) {
  if (!html) return [];

  const messages = [];

  // Each message sits inside a tgme_widget_message_wrap div
  // We extract using the data-post attribute which has the format "channel/msgId"
  const msgBlockRegex = /class="tgme_widget_message_wrap[^"]*"[\s\S]*?data-post="([^"]*)"([\s\S]*?)(?=class="tgme_widget_message_wrap|$)/gi;
  // Simpler: split on message boundaries using data-post
  const postRegex = /data-post="([^"]+)"([\s\S]*?)(?=data-post="|$)/gi;

  let match;
  while ((match = postRegex.exec(html)) !== null && messages.length < 20) {
    const postId = match[1]; // e.g. "intelslava/12345"
    const block = match[2];

    // Extract message text from tgme_widget_message_text
    const textMatch = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    let text = '';
    if (textMatch) {
      text = textMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')     // preserve line breaks
        .replace(/<[^>]+>/g, '')            // strip HTML tags
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#x0*27;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&nbsp;/g, ' ')
        .trim();
    }

    // Extract view count
    const viewsMatch = block.match(/class="tgme_widget_message_views"[^>]*>([\s\S]*?)<\/span>/i);
    let views = 0;
    if (viewsMatch) {
      const raw = viewsMatch[1].trim();
      if (raw.endsWith('K')) views = parseFloat(raw) * 1000;
      else if (raw.endsWith('M')) views = parseFloat(raw) * 1000000;
      else views = parseInt(raw, 10) || 0;
    }

    // Extract datetime
    const timeMatch = block.match(/datetime="([^"]+)"/i);
    const date = timeMatch ? timeMatch[1] : null;

    // Check for media (photos, videos)
    const hasMedia = /tgme_widget_message_photo|tgme_widget_message_video/i.test(block);

    if (text || hasMedia) {
      messages.push({
        postId,
        url: /^\w+\/\d+$/.test(postId) ? `https://t.me/${postId}` : undefined,
        text,
        date,
        views,
        hasMedia,
        channel: channelId,
      });
    }
  }

  return messages;
}

// Scrape a single channel's web preview
async function scrapeChannel(channelId) {
  const url = `https://t.me/s/${channelId}`;
  const html = await fetchHTML(url);
  if (!html) return { channel: channelId, error: 'Failed to fetch', posts: [] };

  // Extract channel title from page
  const titleMatch = html.match(/class="tgme_channel_info_header_title[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    || html.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
    : channelId;

  const posts = parseWebPreview(html, channelId);

  return { channel: channelId, title, posts, postCount: posts.length };
}

// ─── Analysis helpers ───────────────────────────────────────────────────────

// Flag urgent/high-priority posts
export function flagUrgent(post) {
  const lower = (post.text || '').toLowerCase();
  const matched = URGENT_KEYWORDS.filter(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower));
  return matched.length > 0 ? matched : null;
}

// Score a post's significance (views + urgency + length)
function significanceScore(post) {
  let score = 0;
  score += Math.min(post.views / 1000, 50);              // views weight (capped)
  const urgentFlags = flagUrgent(post);
  if (urgentFlags) score += urgentFlags.length * 10;       // urgency weight
  if (post.text?.length > 100) score += 5;                 // substantive text bonus
  if (post.hasMedia) score += 3;                           // media bonus
  return score;
}

// Group posts by topic based on the channel config
function groupByTopic(allPosts, channelMeta) {
  const groups = {};
  for (const post of allPosts) {
    const meta = channelMeta.find(c => c.id === post.channel);
    const topic = meta?.topic || 'other';
    if (!groups[topic]) groups[topic] = [];
    groups[topic].push(post);
  }
  return groups;
}

// ─── Briefing ───────────────────────────────────────────────────────────────

export async function briefing() {
  if (process.env.TELEGRAM_OSINT_ENABLED !== 'true') {
    return { source: 'Telegram', timestamp: new Date().toISOString(), status: 'disabled',
      message: 'Public channel collection is opt-in: TELEGRAM_OSINT_ENABLED=true. Private bot messages are never collected.',
      totalPosts: 0, urgentPosts: [], topPosts: [] };
  }

  // Fallback: scrape public channel web previews (no auth needed)
  const results = [];
  const errors = [];

  // Fetch channels in batches of 3 to avoid rate limiting
  for (let i = 0; i < CHANNELS.length; i += 3) {
    const batch = CHANNELS.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(ch => scrapeChannel(ch.id))
    );
    results.push(...batchResults);

    // Delay between batches to be respectful
    if (i + 3 < CHANNELS.length) await delay(1500);
  }

  // Collect all posts and separate errors
  const allPosts = [];
  const channelSummaries = [];

  for (const r of results) {
    const meta = CHANNELS.find(c => c.id === r.channel);
    if (r.error) {
      errors.push({ channel: r.channel, error: r.error });
    }
    // Enrich posts with urgency flags and scores
    const enriched = (r.posts || []).map(p => ({
      ...p,
      urgentFlags: flagUrgent(p),
      score: significanceScore(p),
    }));
    allPosts.push(...enriched);

    channelSummaries.push({
      channel: r.channel,
      title: r.title || meta?.label || r.channel,
      topic: meta?.topic || 'other',
      postCount: r.postCount || 0,
      reachable: !r.error,
    });
  }

  // Sort all posts by significance
  allPosts.sort((a, b) => b.score - a.score);

  // Separate urgent posts
  const urgentPosts = allPosts.filter(p => p.urgentFlags).slice(0, 15);

  // Group by topic
  const byTopic = groupByTopic(allPosts, CHANNELS);
  const topicSummary = {};
  for (const [topic, posts] of Object.entries(byTopic)) {
    topicSummary[topic] = {
      totalPosts: posts.length,
      urgentCount: posts.filter(p => p.urgentFlags).length,
      topPosts: posts.sort((a, b) => b.score - a.score).slice(0, 5),
    };
  }

  return {
    source: 'Telegram',
    timestamp: new Date().toISOString(),
    status: 'web_scrape',
    method: 'Public channel web preview scraping (no auth required)',
    channelsMonitored: channelSummaries.length,
    channelsReachable: channelSummaries.filter(c => c.reachable).length,
    totalPosts: allPosts.length,
    urgentPosts,
    byTopic: topicSummary,
    channels: channelSummaries,
    errors: errors.length > 0 ? errors : undefined,
    topPosts: allPosts.slice(0, 15),
  };
}

// ─── CLI runner ─────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('telegram.mjs')) {
  console.log('Telegram OSINT — fetching public channel intelligence...\n');
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
