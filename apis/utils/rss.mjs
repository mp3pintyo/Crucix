// Feed parsing for the news ticker: RSS 2.0, RDF (DW) and Atom. The XML is parsed with the same hardened parser as the other
// adapters (no DOCTYPE, no entities, 2 MiB cap); a feed it refuses falls back to the older item-by-item pattern so one odd
// feed never costs its headlines. Only title, link and date are read, and every string is cut to a fixed length.
import { parseXml } from './xml.mjs';

const MAX_ITEMS = 40;
const clean = (value, cap) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);

// A tag value is a string, or an object holding #text (attributes present) or, for Atom links, @_href.
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return textOf(value[0]);
  if (value && typeof value === 'object') return typeof value['#text'] === 'string' ? value['#text'] : '';
  return '';
}

function linkOf(value) {
  const links = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const alternate = links.find(link => link && typeof link === 'object' && (link['@_rel'] === undefined || link['@_rel'] === 'alternate') && typeof link['@_href'] === 'string');
  if (alternate) return alternate['@_href'];
  return textOf(links.find(link => typeof link === 'string') ?? links[0]);
}

function viaXml(xml) {
  const doc = parseXml(xml);
  const root = doc.rss?.channel ?? doc.RDF ?? doc.feed ?? doc.channel;
  if (!root || typeof root !== 'object') return null;
  const raw = doc.rss?.channel?.item ?? doc.RDF?.item ?? doc.feed?.entry ?? doc.channel?.item ?? root.item ?? root.entry;
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return entries.slice(0, MAX_ITEMS).map(entry => ({
    title: clean(textOf(entry?.title), 2000),
    link: clean(linkOf(entry?.link), 2048),
    date: clean(textOf(entry?.pubDate) || textOf(entry?.published) || textOf(entry?.updated) || textOf(entry?.date), 64),
  }));
}

function viaPattern(xml) {
  const items = [];
  const pattern = /<item[\s>]([\s\S]*?)<\/item>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null && items.length < MAX_ITEMS) {
    const block = match[1];
    const pick = tag => block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))?.[1] ?? '';
    items.push({ title: clean(pick('title'), 2000), link: clean(pick('link'), 2048), date: clean(pick('pubDate') || pick('dc:date'), 64) });
  }
  return items;
}

/** Headlines of an RSS/RDF/Atom document: [{ title, link, date }], newest as the feed lists them, at most 40. */
export function parseFeed(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  let items;
  try { items = viaXml(xml); } catch { items = null; }
  if (!items) items = viaPattern(xml);
  return items.filter(item => item.title);
}
