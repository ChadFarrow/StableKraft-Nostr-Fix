import { normalizeUrl } from './url-utils';

// Feed IDs that should never be imported or displayed
export const BLACKLISTED_FEED_IDS = [
  'lnurl-testing-podcast',
  'lnurl-test-feed',
  'podtards-test',
  'bitpunkfm-unwound',
];

// Feed URLs that should never be imported
export const BLACKLISTED_FEED_URLS = [
  'https://zine.bitpunk.fm/feeds/unwound.xml',
  'https://zine.bitpunk.fm/feeds/bitpunk-fm.xml',
];

const normalizedBlacklistedUrls = BLACKLISTED_FEED_URLS.map(normalizeUrl);

export function isBlacklistedFeedId(id: string): boolean {
  return BLACKLISTED_FEED_IDS.includes(id);
}

export function isBlacklistedFeedUrl(url: string): boolean {
  const normalized = normalizeUrl(url);
  return normalizedBlacklistedUrls.includes(normalized);
}

export function getBlacklistedFeedIds(): string[] {
  return [...BLACKLISTED_FEED_IDS];
}
