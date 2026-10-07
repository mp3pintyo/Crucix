// The news feed registry. `tier` follows the public reading of source reliability that World Monitor (koala73/worldmonitor,
// AGPL-3.0) uses: 1 = official bodies and wire services, 2 = major outlets, 3 = specialist, regional and think-tank sources,
// 4 = aggregators and blogs. A tier ranks a source, it does not say a headline is true. `state` marks an outlet that a
// government owns or funds, `lang` the language of its headlines (shown as a tag, headlines are never translated).
// Reachability of every URL was measured from Hungary on 2026-10-08 (HTTP 200).
const feed = (source, url, tier, extra = {}) => Object.freeze({ source, url, tier, lang: 'en', state: false, ...extra });

export const NEWS_FEEDS = Object.freeze([
  // Global and wires
  feed('BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml', 2),
  feed('NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 2),
  feed('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 2, { state: true }),
  feed('Guardian', 'https://www.theguardian.com/world/rss', 2),
  feed('UN News', 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 1),
  // USA
  feed('NPR', 'https://feeds.npr.org/1001/rss.xml', 2),
  feed('BBC Tech', 'https://feeds.bbci.co.uk/news/technology/rss.xml', 2),
  feed('BBC Science', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 2),
  feed('NYT Americas', 'https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml', 2),
  // Europe
  feed('DW', 'https://rss.dw.com/rdf/rss-en-all', 2),
  feed('France 24', 'https://www.france24.com/en/rss', 2),
  feed('Euronews', 'https://www.euronews.com/rss?format=mrss', 2),
  feed('Balkan Insight', 'https://balkaninsight.com/feed/', 3),
  feed('Meduza', 'https://meduza.io/rss/en/all', 2),
  feed('Moscow Times', 'https://www.themoscowtimes.com/rss/news', 2),
  feed('ERR News', 'https://news.err.ee/rss', 2),
  // Hungary
  feed('Telex', 'https://telex.hu/rss', 2, { lang: 'hu' }),
  feed('Index.hu', 'https://index.hu/24ora/rss', 2, { lang: 'hu' }),
  feed('HVG', 'https://hvg.hu/rss', 2, { lang: 'hu' }),
  feed('444.hu', 'https://444.hu/feed', 2, { lang: 'hu' }),
  feed('24.hu', 'https://24.hu/feed/', 2, { lang: 'hu' }),
  feed('Portfolio.hu', 'https://portfolio.hu/rss/all.xml', 2, { lang: 'hu' }),
  feed('ATV', 'https://www.atv.hu/rss', 2, { lang: 'hu' }),
  // Middle East and Turkey
  feed('Jerusalem Post', 'https://www.jpost.com/rss/rssfeedsheadlines.aspx', 2),
  feed('The National', 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml', 2),
  feed('Daily Sabah', 'https://www.dailysabah.com/rss/home-page', 3, { state: true }),
  // Africa
  feed('DW Africa', 'https://rss.dw.com/rdf/rss-en-africa', 2),
  feed('RFI', 'https://www.rfi.fr/en/rss', 2),
  feed('Africa News', 'https://www.africanews.com/feed/rss', 3),
  feed('NYT Africa', 'https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml', 2),
  // Asia-Pacific
  feed('NYT Asia', 'https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml', 2),
  feed('SBS Australia', 'https://www.sbs.com.au/news/topic/australia/feed', 2),
  feed('ABC Australia', 'https://www.abc.net.au/news/feed/2942460/rss.xml', 2),
  feed('CNA', 'https://www.channelnewsasia.com/rssfeeds/8395986', 2),
  feed('The Diplomat', 'https://thediplomat.com/feed/', 3),
  feed('Dawn', 'https://www.dawn.com/feeds/home/', 2),
  feed('Indian Express', 'https://indianexpress.com/section/india/feed/', 2),
  feed('The Hindu', 'https://www.thehindu.com/news/national/feeder/default.rss', 2),
  // Latin America
  feed('MercoPress', 'https://en.mercopress.com/rss/latin-america', 3),
  feed('Mexico News Daily', 'https://mexiconewsdaily.com/feed/', 3),
  feed('InSight Crime', 'https://insightcrime.org/feed/', 3),
  // Defence, security and think tanks
  feed('Defense One', 'https://www.defenseone.com/rss/all/', 3),
  feed('The War Zone', 'https://www.twz.com/feed', 3),
  feed('Breaking Defense', 'https://breakingdefense.com/feed/', 3),
  feed('War on the Rocks', 'https://warontherocks.com/feed/', 3),
  feed('Foreign Policy', 'https://foreignpolicy.com/feed/', 3),
  feed('Crisis Group', 'https://www.crisisgroup.org/rss', 3),
  feed('Oryx', 'https://www.oryxspioenkop.com/feeds/posts/default?alt=rss', 3),
  feed('IAEA', 'https://www.iaea.org/feeds/topnews', 1),
  feed('WHO News', 'https://www.who.int/rss-feeds/news-english.xml', 1),
  feed('Krebs', 'https://krebsonsecurity.com/feed/', 3),
  feed('OilPrice', 'https://oilprice.com/rss/main', 4),
]);

const BY_SOURCE = new Map(NEWS_FEEDS.map(item => [item.source, item]));

/** The registry entry of a feed, by the source name it is shown under (undefined for an unknown name). */
export const feedBySource = name => BY_SOURCE.get(name);

/** Sources of the "reserve" lists of the selection: one slot each so a busy feed cannot crowd the others out. */
export const HUNGARIAN_SOURCES = Object.freeze(NEWS_FEEDS.filter(item => item.lang === 'hu').map(item => item.source));
export const OFFICIAL_SOURCES = Object.freeze(NEWS_FEEDS.filter(item => item.tier === 1).map(item => item.source));
