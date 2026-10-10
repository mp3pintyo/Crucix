// Country-search fallbacks, NOT native publisher feeds.
// Their HTTP/XML/item/freshness checks are in search-audit.json.
// New tier=3 is a provisional integration value, NOT an editorial credibility rating.
// Language inferred from title samples where possible; freshness/ownership details: registry.json.
// Usage: const feeds = createCountryFallbackFeeds(feed);
export function createCountryFallbackFeeds(feed) {
  return [

    // Kiribati (KI)
    feed("Kiribati – Google News (English search)", "https://news.google.com/rss/search?q=%22Kiribati%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "KI"}),

    // Liechtenstein (LI)
    feed("Liechtenstein – Google News (English search)", "https://news.google.com/rss/search?q=%22Liechtenstein%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "LI"}),

    // Marshall Islands (MH)
    feed("Marshall Islands – Google News (English search)", "https://news.google.com/rss/search?q=%22Marshall+Islands%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "MH"}),

    // Micronesia (FM)
    feed("Micronesia – Google News (English search)", "https://news.google.com/rss/search?q=%22Micronesia%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "FM"}),

    // Nauru (NR)
    feed("Nauru – Google News (English search)", "https://news.google.com/rss/search?q=%22Nauru%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "NR"}),

    // North Korea (KP)
    feed("North Korea – Google News (English search)", "https://news.google.com/rss/search?q=%22North+Korea%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "KP"}),

    // Samoa (WS)
    feed("Samoa – Google News (English search)", "https://news.google.com/rss/search?q=%22Samoa%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "WS"}),

    // Seychelles (SC)
    feed("Seychelles – Google News (English search)", "https://news.google.com/rss/search?q=%22Seychelles%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "SC"}),

    // Tonga (TO)
    feed("Tonga – Google News (English search)", "https://news.google.com/rss/search?q=%22Tonga%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "TO"}),

    // Tuvalu (TV)
    feed("Tuvalu – Google News (English search)", "https://news.google.com/rss/search?q=%22Tuvalu%22&hl=en-US&gl=US&ceid=US%3Aen", 3, {"lang": "en", "country": "TV"}),
  ];
}
