/**
 * Curated list of podcast feeds to show under the "Podcasts" filter.
 * These are source podcasts (music discovery shows) that are normally
 * blacklisted from the album view. Add new podcast feeds here.
 */
export const PODCAST_FEED_IDS: string[] = [
  '3aebb7a8-5942-5ee7-a148-8bdc14f1f3d4', // Upbeats
];

export const PODCAST_FEED_URLS: string[] = [
  'https://serve.podhome.fm/rss/3aebb7a8-5942-5ee7-a148-8bdc14f1f3d4', // Upbeats
];

/** Slugs that should redirect from /album/ to /podcast/ */
export const PODCAST_SLUGS: string[] = [
  'upbeats',
];
