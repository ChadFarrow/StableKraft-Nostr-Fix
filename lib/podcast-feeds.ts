/**
 * Curated list of podcast feeds to show under the "Podcasts" filter.
 * These are source podcasts (music discovery shows) that are normally
 * blacklisted from the album view. Add new podcast feeds here.
 */
export const PODCAST_FEED_IDS: string[] = [
  '3aebb7a8-5942-5ee7-a148-8bdc14f1f3d4', // Upbeats
  'silvie-two-for-tunestr',                // Two For Tunestr
];

export const PODCAST_FEED_URLS: string[] = [
  'https://serve.podhome.fm/rss/3aebb7a8-5942-5ee7-a148-8bdc14f1f3d4', // Upbeats
  'https://serve.podhome.fm/rss/fafd2bfc-98ac-5010-9fcb-7403abfd420a', // Two For Tunestr
];

/** Slugs that should redirect from /album/ to /podcast/ */
export const PODCAST_SLUGS: string[] = [
  'upbeats',
  'two-for-tunestr',        // Two For Tunestr (canonical)
  'silvie-two-for-tunestr', // Two For Tunestr (DB ID)
];

/** Map slug to DB feed ID (when slug differs from feed ID) */
export const PODCAST_SLUG_TO_FEED_ID: Record<string, string> = {
  'two-for-tunestr': 'silvie-two-for-tunestr',
};

/** Map DB feed ID to canonical slug (for redirects) */
export const PODCAST_CANONICAL_SLUGS: Record<string, string> = {
  'silvie-two-for-tunestr': 'two-for-tunestr',
};
