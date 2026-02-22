import { normalizeUrl } from './url-utils';

// Feed IDs that should never be imported or displayed
export const BLACKLISTED_FEED_IDS = [
  'lnurl-testing-podcast',
  'lnurl-test-feed',
  'podtards-test',
  'bitpunkfm-unwound',
  'bitpunk-fm-unwound-1768079479444',  // bitpunk.fm unwound podcast
  'f38e27af-fb9e-46ef-9ed9-5d8046d094a9',  // Before The Sch3m3s source podcast
  'album-1769878596791-picsarstu',       // MMM source podcast
  'homegrown-hits-1768079163338',        // HGH source podcast
  'lightning-thrashes-1768079468212',     // LT source podcast
  '3aebb7a8-5942-5ee7-a148-8bdc14f1f3d4', // Upbeats source podcast
  '469b403f-db2d-574c-9db9-96dbb3f6561c', // IAM source podcast
  'album-1769878598351-2xjjso3ew',       // ITDV source podcast
];

// Feed URLs that should never be imported
export const BLACKLISTED_FEED_URLS = [
  'https://zine.bitpunk.fm/feeds/unwound.xml',
  'https://zine.bitpunk.fm/feeds/bitpunk-fm.xml',
  'https://music.behindthesch3m3s.com/b4ts%20feed/feed.xml',  // B4TS source podcast
  'https://mmmusic-project.ams3.cdn.digitaloceanspaces.com/Mutton_Mead__Music/feed.xml',  // MMM source podcast
  'https://feed.homegrownhits.xyz/feed.xml',  // HGH source podcast
  'https://sirlibre.com/lightning-thrashes-rss.xml',  // LT source podcast
  'https://feeds.rssblue.com/upbeats',  // Upbeats source podcast
  'https://itsamood.org/itsamoodrss.xml',  // IAM source podcast
  'https://www.doerfelverse.com/feeds/intothedoerfelverse.xml',  // ITDV source podcast
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
