# Stablekraft App

## Commands
```
npm run dev          # Start dev server
npm run build        # Build for production
npm run db:studio    # Open Prisma Studio
npm run deploy       # Build deployment package (local)
git push origin main # Deploy to production (Railway auto-deploys from git)
```

## Boundaries
- Never commit secrets (`.env`, API keys)
- Run `npm run build` before committing
- No `src/` directory — all source lives in `app/`, `lib/`, `components/`, `contexts/`
- No `deploy-*/` artifacts in the repo — add to `.gitignore` if generated
- No JSON-file databases — all data is in PostgreSQL via Prisma (the old `data/archived-json-database/` was removed)

## Tech Stack
- Next.js 15 (App Router), React 18, TypeScript, PostgreSQL/Prisma
- Podcast Index API for all feed lookups and resolution (never fetch directly from Wavlake — use PI API)
- Nostr for auth, Lightning (Alby/WebLN) for payments

## Architecture

### Two-Repo Setup
- **musicL-playlist-updater** - Generates playlist XML feeds
- **stablekraft-app** (this repo) - Consumes and displays playlists

### Daily Workflow (`.github/workflows/refresh-playlists.yml`)
Runs at 4 AM EST: clears cache -> reparses feeds -> refreshes playlists -> parses publishers -> imports missing albums from publisher feeds (Step 5b via PI API)

## Key Behaviors

### Playlist Resolution
Playlists use `<podcast:remoteItem>` with `feedGuid` + `itemGuid`. On `?refresh`:
1. Find feeds without tracks, parse immediately
2. Discover missing feeds via Podcast Index API
3. Parse new feeds (imports tracks + V4V data)
4. Discover/link publisher feeds

**Publisher discovery** (`discoverAndParsePublishers` in `lib/feed-discovery.ts`): First checks album XML for `<podcast:remoteItem medium="publisher">` tags. If absent, falls back to Podcast Index API search by artist name (`findPublisherFeed` in `lib/publisher-detector.ts`). Deduplicates PI API calls per-artist within a run. Daily workflow Step 4 (`POST /api/playlist/parse-feeds`) also runs publisher discovery after parsing.

**Publisher album import** (`POST /api/admin/publishers/import-albums`): Uses PI API search by artist name (`/search/byterm`) to find music feeds, then PI API episodes (`/episodes/byfeedid`) for track data. No direct Wavlake XML fetching — avoids 429 rate limiting. Deduplicates PI searches per-artist across multiple publisher feeds. Daily workflow Step 5b calls this automatically.

**Duplicate ID gotcha**: Podcast Index uses numeric IDs (`6876105`) while our DB uses GUIDs (`b2048129-...`). When `importFeedToDatabase` finds a URL already exists under a different ID, it redirects to the existing feed and imports tracks into it (see `lib/feed-parsing.ts`).

**Feed deduplication pattern**: Both `import-albums/route.ts` and `process-remote-items/route.ts` use the same multi-check dedup: normalized URL, raw URL, feedGuid as ID, feedGuid as GUID column, feedGuid-in-URL substring. After parsing, a secondary check catches feeds by `podcastGuid` from the XML. New feeds get slug-based IDs (`artist-title` via `generateAlbumSlug`) and are linked to their publisher via `publisherId`. When modifying feed import code, follow this pattern — weak dedup (e.g., `findUnique` on raw URL only) causes duplicate entries.

**Type filter gotcha**: Wavlake feeds imported via Podcast Index API often get `type: 'podcast'` (when PI returns `feedData.type !== 1`). All DB queries for album/music content must include `'podcast'` in the type filter: `type: { in: ['album', 'music', 'podcast'] }`. This applies to publisher page queries, publisher discovery/linking, and import-albums artist linking.

**Resolution rate**: Expect 80-90%. Gaps come from dead feeds (removed from Podcast Index), duplicate GUIDs across platforms (Wavlake vs original publisher), and duplicate URLs under different feedGuid values.

### Admin Feed Management (`/admin`)
Single input handles both add and reparse:
- New feeds -> added and parsed automatically
- Existing feeds -> reparsed to update content
- Auto-detects type from URL (`-pubfeed` = publisher)

**Fixing duplicate feeds**: Reparsing won't consolidate duplicates — delete all copies first, then re-add. Use `DELETE /api/feeds?id=<feedId>` for each duplicate, then paste the feed URL in the admin input. The delete-by-URL endpoint (`POST /api/admin/feeds/delete-by-url`) supports preview mode. The per-ID endpoint (`DELETE /api/admin/feeds/[id]`) is currently disabled (503).

### Search
- Uses PostgreSQL trigram `similarity()` for fuzzy matching
- Artist search groups by `LOWER(artist)` to avoid case duplicates
- Exact mode: `?fuzzy=false`

### Publisher Pages (`app/publisher/[id]/page.tsx`)
Matched by: title slug, artist slug, or URL path (e.g., `/setto/` matches "setto")
- `<podcast:podroll>` sections filtered out (not albums)
- `-pubfeed.xml` URLs skipped

**Multi-feed support**: Artists can have multiple publisher feeds (e.g., separate Wavlake and Fountain.fm feeds). `loadPublisherData` finds all publisher feeds for the artist (using name variants for `And→&`, `Plus→+`) and fetches XML from each to collect remote items. Image is extracted from the primary feed only.

**Per-platform sections**: When a publisher has albums from multiple platforms, the "Official Releases" section is split into per-platform sections (e.g., "Prosperous Soul (Wavlake)", "Prosperous Soul (RSS Blue)", "Prosperous Soul (Fountain.fm)"). Albums are assigned to sections by: (1) `publisherId` from DB, then (2) GUID match to source feed XML, then (3) URL match, then (4) fallback to primary feed. If a single publisher feed's albums span multiple platforms (e.g., Wavlake publisher with RSS Blue albums linked via `publisherId`), the section is split by `getPlatformName()` which detects platform from album `originalUrl` hostname. Single-feed, single-platform publishers show the original "Official Releases" header with no platform suffix. Client renders sections via `feedSections` prop in `PublisherDetailClient.tsx`.

**Album resolution order**: (1) Remote item GUIDs/URLs from all publisher feed XMLs → (2) `publisherId`-linked albums in DB (filtered by podroll blocklist) → (3) Artist name matching for remaining albums. GUID matching checks `Feed.id`, `Feed.guid` column (critical for Wavlake), and URL patterns.

### Duration Filtering
Tracks over 2 hours filtered as non-music (silent, no warnings)

### NIP-46 Remote Signer (Amber)
iOS Safari kills WebSocket connections after ~30s when backgrounded. The client reconnects on `visibilitychange` with platform-aware staleness thresholds (iOS 15s, others 60s). Key files: `lib/nostr/nip46-client.ts`, `components/Nostr/hooks/useNip46Connection.ts`.

### iOS PWA Background Audio
iOS suspends audio when the PWA is backgrounded. Mitigated in `contexts/AudioContext.tsx` with silent keepalive audio and visibility handlers (`visibilitychange`/`pageshow`). **Critical**: do not auto-resume if the user explicitly paused (e.g., via lock screen controls) — check both "was playing" and "user paused" state before resuming on foreground.

### Sorting
**Server-side sort**: `/api/albums-fast` accepts a `sort` query param (`added-desc`, `added-asc`, `year-desc`, `year-asc`, `name-asc`, `name-desc`, `tracks-desc`, `tracks-asc`). Sort is applied *before* pagination so paginated results are in the correct order. The client (`app/page.tsx`) only sends `sort` for non-default sorts — omitting it gives the server's default format+alpha sort (Albums → EPs → Singles, then A-Z within each). **Do NOT send `sort=name-asc` as default** — it bypasses format grouping. The client re-fetches from page 1 when sort changes via a `useEffect` on `sortType`. localStorage cache is skipped for non-default sorts.

Date fields (not obvious from UI):
- `Feed.oldestItemPubdate` — Album release date (from tracks). Auto-set during feed parsing (`importFeedToDatabase`) and album import (`import-albums/route.ts`). Manual backfill: `POST /api/admin/backfill-oldest-pubdate`
- `Feed.createdAt` — When added to site
- Publishers use oldest album's `createdAt` as their `dateAdded`

### Adding New Playlists
Files to modify (8 total):
1. `lib/playlist/configs.ts` - Add config entry with id, url, name, shortName, etc.
2. `app/api/playlist/[id]/route.ts` - Create main API route using `createPlaylistHandler`
3. `app/api/playlist/[id]-fast/route.ts` - Create fast API route for placeholder data
4. `lib/playlist-track-counts.ts` - Add to both `FALLBACK_COUNTS` and `PLAYLIST_URLS`
5. `app/api/playlists-fast/route.ts` - Add playlist summary to the array
6. `app/page.tsx` - Add to fallback `Promise.allSettled` array (~line 760)
7. `app/playlist/[id]/page.tsx` - Create dedicated playlist page
8. `app/favorites/page.tsx` - Add to `playlistTitles` array, `playlistImageFallbacks` map, and `playlistSlugOverrides` if the config ID doesn't match the URL slug

After code changes, populate database: `curl http://localhost:3000/api/playlist/[id]?refresh`

### Playlist Page UI
- All playlist pages use `PlaylistTemplateCompact` component
- Back button links to `/?filter=playlist` (the main page Playlists filter)
- Grouped view (episodes/play counts): `EpisodeSection.tsx` renders collapsible sections
- Tracks panel background: `bg-black/75` for readability over page backgrounds
- Track rows in grouped view: single-row horizontal layout with `bg-black/50`

### Nostr Publish Queue & Relay Management
Favoriting saves to DB immediately (no `nostrEventId`), then queues Nostr publish in the background. Queue flushes with 500ms debounce, creating one `RelayManager` for all pending events. After publish, `FavoriteButton` PATCHes the `nostrEventId` back to the DB.

**Relay rules**: `RelayManager` uses a 5s connection timeout (`Promise.race` — nostr-tools has no built-in timeout). **Always call `disconnectAll()`** after publishing or WebSocket connections leak. Key files: `lib/nostr/publish-queue.ts`, `lib/nostr/relay.ts`.

### Favorites Page (`/favorites`)
- **Optimistic unfavorite** — removes track from local state immediately, no reload
- **Auto-sync** — `useAutoSyncFavorites` batch-publishes unpublished favorites on page load (1.5s delay)
- **Playlist favorites gotcha**: Playlists aren't Feed rows, so the API returns the raw `feedId` as title. The `isPlaylist()` check and `playlistImageFallbacks` map must use the **lowercased feedId** (e.g., `'greatesthits'`), not the human name. `playlistSlugOverrides` handles ID-to-slug mismatches (e.g., `greatestHits-playlist` → `greatest-hits`).

### Nostr Playlist Publishing
Favorites can be shared as a kind 34139 addressable Nostr event (`d` tag = `stablekraft-favorites`). Re-publishing replaces the previous version (same `d` tag). Key files: `lib/nostr/playlist-events.ts`, `components/favorites/PublishPlaylistButton.tsx`.

### Favorite Publishers Resolution (`app/api/favorites/albums/route.ts`)
Publisher favorites use three feedId formats:
- **Synthetic artist IDs** (`artist-adam-curry`) — resolved by querying album feeds by artist name
- **Feed GUIDs** (`d7b4abee-...`) — fallback lookup by `Feed.guid` column
- **Feed IDs** (`wavlake-publisher-aa909244`) — direct `Feed.id` match

**Image chain**: DB feed image → Podcast Index API → album feed image by artist name (publisher feeds often lack artwork). **NIP-51 republish** excluded for publisher favorites — only tracks and albums support it.

### BackButton (`components/BackButton.tsx`)
Uses `window.history.length` to detect prior navigation. Do NOT use `document.referrer` — it doesn't update during SPA navigation.

### Lightning Wallet Detection (`components/Lightning/BitcoinConnectProvider.tsx`)
Keysend capability is inferred from provider type (`hasKeysendMethod && type !== 'unknown'`). Do NOT probe by sending a real keysend payment — wallets like Alby extension surface this as a user-facing payment popup on every page load. When the Alby extension auto-connects via `window.webln` (bypassing Bitcoin Connect), `detectWalletProviderType()` in `lib/lightning/wallet-detection.ts` falls back to checking `window.webln` and returns `type: 'extension'` — without this, keysend detection fails for the Alby extension.

### BoostBox Integration (`lib/lightning/boostbox.ts`)
LNURL payments use [BoostBox](https://boostbox.cloud) to store Podcasting 2.0 boost metadata. Before requesting an LNURL invoice, metadata is POSTed to BoostBox which returns a `desc` string (e.g., `rss::payment::boost https://boostbox.cloud/boost/01K9... message`). That `desc` becomes the LNURL invoice comment so recipients can fetch full payment context. Keysend payments are unaffected — they use Helipad TLV records directly.

- API spec: https://boostbox.cloud/openapi.json
- Docs: https://boostbox.cloud/docs
- Source: https://github.com/noblepayne/boostbox
- Server-side proxy: `app/api/lightning/boostbox/route.ts` (avoids CORS, API key via `BOOSTBOX_API_KEY` env var)
- Feature flag: `LIGHTNING_CONFIG.features.boostbox` in `lib/lightning/config.ts`
- If BoostBox is unreachable, payments proceed without metadata (graceful degradation)
- LNURL comment length: `requestInvoice()` in `lib/lightning/lnurl.ts` truncates comments exceeding the server's `commentAllowed` limit instead of throwing — preserves the BoostBox URL at the start of `desc`
- `boostbox.ts` is client-only — always uses the `/api/lightning/boostbox` proxy (no direct BoostBox calls or API keys in the client bundle)

**BoostBox metadata field mapping**: `buildHelipadMetadata` → `mapHelipadToBoostBox` populates BoostBox payload fields from Helipad metadata. Key mappings: `feed_guid` ← `remote_feed_guid`, `feed_title` ← `album` (falls back to `podcast`/artist name), `publisher_guid` ← `publisher_guid`, `item_guid` ← `episode_guid`/`remote_item_guid`, `sender_id`/`sender_npub` ← passed through from Helipad, `group` ← `uuid` (groups all splits from same boost, matching Fountain/Castamatic), `remote_publisher_guid` ← `publisher_guid`, `boost_link` ← passed through. `split` is sent as a whole number percentage (e.g., `20` for 20%).

**BoostBox vs keysend**: Value splits try keysend first (preferred for Helipad TLV metadata). BoostBox is only called when a recipient falls through to LNURL — either because the recipient's Lightning Address doesn't return keysend info (e.g., Strike, Zeus, Primal) or the wallet doesn't support keysend. Fountain.fm addresses skip keysend by design (see `isFountain` check in `value-splits.ts`). Whether the BoostBox `desc` URL is visible in the sender/recipient wallet depends on the LNURL server's `commentAllowed` support — Strike shows it, Fountain.fm does not.

### Helipad Metadata (`components/Lightning/BoostButton.tsx`)
Helipad metadata for boost payments is built by `buildHelipadMetadata(amount, msg)` inside `BoostButton`, following the BLIP-0010 spec for keysend TLV 7629169. This single helper is used by all payment paths (direct LNURL, direct keysend, value splits, and platform fee metaboost). Do NOT duplicate the metadata construction — add new fields to the helper. The `name` field is intentionally omitted from the base metadata; in value splits, `value-splits.ts` sets `name` per-recipient to identify which split the payment is for (BLIP-0010). Key fields: `guid` (preferred podcast identifier from `remoteFeedGuid`), `sender_id`/`sender_npub` (Nostr npub if authenticated), `url` (feed URL — no `feed` or `feedId` fields).

**BoostButton props for metadata**: When adding BoostButton to a page, pass these props for complete BoostBox/Helipad metadata: `feedUrl` (album RSS URL), `remoteFeedGuid` (album's podcast:guid or feedId), `albumName` (album/feed title), `publisherGuid` (publisher's feed ID), `episodeGuid` (track GUID). The album slug API (`/api/albums/[slug]`) returns `feedGuid` (the `Feed.guid` column from the DB) alongside `feedId`. For track-level BoostButtons on album pages, `remoteFeedGuid` should fall back to the album: `track.v4vValue?.feedGuid || album.feedGuid || album.feedId`.

### Episode/Play Count Markers
Playlists can include `<podcast:txt purpose="episode">` or `<podcast:txt purpose="playcount">` markers in XML to group tracks into collapsible sections. After adding markers, refresh: `curl https://stablekraft.app/api/playlist/[id]?refresh`
