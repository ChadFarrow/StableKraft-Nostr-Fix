-- Add compound index for publisher album queries (publisherId + status)
CREATE INDEX IF NOT EXISTS "Feed_publisherId_status_idx" ON "Feed"("publisherId", "status");

-- Add index on Track.audioUrl for favorite matching lookups
CREATE INDEX IF NOT EXISTS "Track_audioUrl_idx" ON "Track"("audioUrl");

-- Add expression index for case-insensitive artist grouping (GROUP BY LOWER(artist))
CREATE INDEX IF NOT EXISTS "Feed_artist_lower_idx" ON "Feed" (LOWER("artist")) WHERE "artist" IS NOT NULL;

-- Add index on Feed.oldestItemPubdate for release-date sorting
CREATE INDEX IF NOT EXISTS "Feed_oldestItemPubdate_idx" ON "Feed"("oldestItemPubdate") WHERE "oldestItemPubdate" IS NOT NULL;
