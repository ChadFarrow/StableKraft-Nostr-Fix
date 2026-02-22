import { normalizeUrl } from './url-utils';

// Feed IDs that should never be imported or displayed
export const BLACKLISTED_FEED_IDS = [
  'lnurl-testing-podcast',
  'lnurl-test-feed',
  'podtards-test',
  'bitpunkfm-unwound',
  'bitpunk-fm-unwound-1768079479444',  // bitpunk.fm unwound podcast
  'f38e27af-fb9e-46ef-9ed9-5d8046d094a9',  // Before The Sch3m3s source podcast
];

// Feed URLs that should never be imported
export const BLACKLISTED_FEED_URLS = [
  'https://zine.bitpunk.fm/feeds/unwound.xml',
  'https://zine.bitpunk.fm/feeds/bitpunk-fm.xml',
  'https://music.behindthesch3m3s.com/b4ts%20feed/feed.xml',  // B4TS source podcast
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
