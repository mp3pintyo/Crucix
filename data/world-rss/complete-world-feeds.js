// Native/regional feeds plus country-search fallbacks for gaps.
import { createWorldFeeds } from './world-feeds.js';
import { createCountryFallbackFeeds } from './country-fallback-feeds.js';
export function createCompleteWorldFeeds(feed) {
  return [...createWorldFeeds(feed), ...createCountryFallbackFeeds(feed)];
}
