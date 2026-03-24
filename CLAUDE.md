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
- No JSON-file databases — all data is in PostgreSQL via Prisma

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
Playlists use `<podcast:remoteItem>` with `feedGuid` + `itemGuid`. On `?refresh`: discover missing Feed records via PI API → parse new feeds → discover/link publisher feeds → resolve tracks. Resolution rate ~80-90%.

**Feed discovery on refresh** (`lib/playlist/handler.ts`): always runs `processPlaylistFeedDiscovery` for all feedGuids, not just unresolved tracks. Tracks can resolve via Track GUIDs even when parent Feed records don't exist as browsable albums — discovery must check Feed existence independently.

**Publisher discovery** (`lib/feed-discovery.ts`): checks album XML for publisher tags (`parsePublisherFeedFromXML`), falls back to PI API search by artist name. Deduplicates PI API calls per-artist.

**Publisher album import** (`POST /api/admin/publishers/import-albums`): uses PI API `/search/byterm` + `/episodes/byfeedid`. No direct Wavlake XML fetching (avoids 429s). Deduplicates per-artist.

**Feed deduplication pattern**: multi-check dedup (normalized URL, raw URL, feedGuid as ID, feedGuid as GUID column, feedGuid-in-URL substring, then secondary `podcastGuid` check). New feeds get slug-based IDs via `generateAlbumSlug`. When modifying feed import code, follow this pattern — weak dedup causes duplicate entries.

**Type filter gotcha**: Wavlake feeds often get `type: 'podcast'`. All DB queries for album/music content must include `'podcast'` in the type filter: `type: { in: ['album', 'music', 'podcast'] }`.

**PI API status gotcha**: `normalizeFeedResponse` in `lib/podcast-index-api.ts` must accept both `status: 'true'` (string) and `status: true` (boolean) — the PI API returns either. Use `data.status !== 'true' && data.status !== true` for rejection checks. The `=== 'true'` checks elsewhere are safe (boolean `true` is truthy in `&&` chains).

**Podroll exclusion**: `process-remote-items/route.ts` strips `<podcast:podroll>` sections before extracting `<podcast:remoteItem>` tags. Without this, podroll-referenced feeds get imported as albums.

### Feed Blacklist (`lib/feed-exclusions.ts`)
Central exclusion config: `BLACKLISTED_FEED_IDS`, `BLACKLISTED_FEED_URLS`. Helpers: `isBlacklistedFeedId()`, `isBlacklistedFeedUrl()`.

### Admin Feed Management (`/admin`)
Single input handles both add and reparse. Auto-detects type from URL (`-pubfeed` = publisher). **Fixing duplicates**: delete all copies first (`DELETE /api/feeds?id=<feedId>`), then re-add.

### Search
- PostgreSQL trigram `similarity()`, flat 0.3 threshold. Do NOT lower below 0.3 — causes false positives.
- Artist search groups by `LOWER(artist)`. Exact mode: `?fuzzy=false`

### Publisher Pages (`app/publisher/[id]/page.tsx`)
Matched by: title slug, artist slug, or URL path. Multi-feed support with per-platform sections. Album resolution: (1) GUIDs/URLs from publisher feed XMLs → (2) `publisherId`-linked albums → (3) artist name matching. Do NOT re-add platform filters — hides legitimate cross-platform albums.

### Duration Filtering
Tracks over 2 hours filtered as non-music (silent, no warnings)

### NIP-46 Remote Signer (Amber / Primal)
Key files: `lib/nostr/nip46-client.ts`, `components/Nostr/hooks/useNip46Connection.ts`. iOS Safari kills WebSocket connections after ~30s backgrounded; reconnects on `visibilitychange` (iOS 15s threshold, others 60s). **Primal is the best iOS signer** — auto-signs with Full trust, responds <1s.

Performance optimizations in `nip46-client.ts`:
- **Debug logging** gated behind `localStorage.setItem('nip46_debug', 'true')` — zero `console.log` in production, `console.error`/`console.warn` preserved
- **Adaptive rate limiting** (500ms–2000ms) based on actual signer response times instead of fixed 2s
- **Pre-decrypted content** passed to `handleRelayEvent` to avoid double NIP-44 decryption
- **Smart subscription filters** with `authors: [signerPubkey]` when known, broad filter only during QR scan
- **Subscription delays** reduced to 500ms (non-bunker) / 1s (bunker), was 2s
- **Lightweight reconnection** checks `getConnectedRelays()` before full teardown
- **Orphaned request cleanup** every 60s removes requests older than 120s
- **Keypair cache** (`lastSuccessfulKeyPairIndex`) avoids linear search through historical keypairs

### iOS PWA Background Audio
Three-layer strategy in `contexts/AudioContext.tsx`:
1. **Preload** at 15s before end — hidden `Audio` element + `prefetchAudio()` warm cache
2. **Proactive timer** at 5s before end — `setTimeout` fires ~200ms after expected end
3. **Visibility change safety net** — `playNextTrack` on foreground if audio ended

`trackEndProcessedRef` prevents double-advance. **Critical**: do not auto-resume if user explicitly paused — check both "was playing" and "user paused" state.

### Sorting
`/api/albums-fast` accepts `sort` param (`added-desc`, `added-asc`, `year-desc`, `year-asc`, `name-asc`, `name-desc`, `tracks-desc`, `tracks-asc`). Sort applied before pagination. **Do NOT send `sort=name-asc` as default** — it bypasses format grouping (Albums → EPs → Singles).

Date fields: `Feed.oldestItemPubdate` = album release date, `Feed.createdAt` = when added to site. Backfill: `POST /api/admin/backfill-oldest-pubdate`.

### Adding New Playlists
Files to modify (9 total):
1. `lib/playlist/configs.ts` - Config entry
2. `app/api/playlist/[id]/route.ts` - Main API route
3. `app/api/playlist/[id]-fast/route.ts` - Fast API route
4. `lib/playlist-track-counts.ts` - `FALLBACK_COUNTS` and `PLAYLIST_URLS`
5. `app/api/playlists-fast/route.ts` - Playlist summary
6. `app/page.tsx` - Fallback `Promise.allSettled` array
7. `app/playlist/[id]/page.tsx` - Dedicated page
8. `app/favorites/page.tsx` - `playlistTitles`, `playlistImageFallbacks`, `playlistSlugOverrides`
9. `.github/workflows/refresh-playlists.yml` - Add to `PLAYLISTS` array

Populate: `curl https://stablekraft.app/api/playlist/[id]?refresh` — this discovers missing Feed records, parses them, discovers publishers, and resolves tracks.

### Playlist Page UI
All pages use `PlaylistTemplateCompact`. Back button → `/?filter=playlist`. Grouped view: `EpisodeSection.tsx`. Track rows: `bg-black/50` over `bg-black/75` panel.

### Nostr Publish Queue & Relay Management
Favoriting saves to DB immediately, queues Nostr publish (500ms debounce). **Always call `disconnectAll()`** after publishing or WebSocket connections leak. Key files: `lib/nostr/publish-queue.ts`, `lib/nostr/relay.ts`.

### Favorites Page (`/favorites`)
Optimistic unfavorite, auto-sync on page load. **Playlist favorites gotcha**: `isPlaylist()` and `playlistImageFallbacks` must use **lowercased feedId**, not the human name. `playlistSlugOverrides` handles ID-to-slug mismatches.

### Nostr Playlist Publishing
Kind 34139 addressable event (`d` tag = `stablekraft-favorites`). Re-publishing replaces previous version. Key files: `lib/nostr/playlist-events.ts`, `components/favorites/PublishPlaylistButton.tsx`.

### Favorite Publishers Resolution (`app/api/favorites/albums/route.ts`)
Three feedId formats: synthetic artist IDs (`artist-adam-curry`), feed GUIDs, feed IDs. Image chain: DB → PI API → album feed image by artist name.

### BackButton (`components/BackButton.tsx`)
Uses `window.history.length`. Do NOT use `document.referrer` — doesn't update during SPA navigation.

### Lightning Wallet Detection
Keysend inferred from provider type (`hasKeysendMethod && type !== 'unknown'`). Do NOT probe with real keysend — triggers payment popup. Alby extension detection: `detectWalletProviderType()` in `lib/lightning/wallet-detection.ts`.

### BoostBox Integration (`lib/lightning/boostbox.ts`)
LNURL payments use [BoostBox](https://tardbox.com) for Podcasting 2.0 boost metadata. Keysend unaffected (uses Helipad TLV). Graceful degradation if unreachable. Client-only — always uses `/api/lightning/boostbox` proxy (API key via `BOOSTBOX_API_KEY` env var). Feature flag: `LIGHTNING_CONFIG.features.boostbox`.

- Source: https://github.com/ChadFarrow/boostbox
- `requestInvoice()` truncates comments exceeding `commentAllowed` limit — preserves BoostBox URL at start

**BoostBox vs keysend**: Value splits try keysend first. BoostBox called only for LNURL fallback. Fountain.fm addresses skip keysend by design (`isFountain` check).

**Feed.guid gotcha**: `feed_guid` in BoostBox comes from `Feed.guid` in DB. If null, reparse the feed. Written during import from `<podcast:guid>` tag.

**BoostBox → Helipad flow**: LNURL boost comment contains `rss::payment::boost https://tardbox.com/boost/<id> <message>`. Helipad sends HEAD to that URL, reads `x-rss-payment` header (URL-encoded JSON metadata). BoostBox serves both GET and HEAD on `/boost/:id`. Helipad's `metadata.rs` regex must include `tardbox.com` — upstream PR: [Podcastindex-org/helipad#148](https://github.com/Podcastindex-org/helipad/pull/148).

### VTS (Value Time Splits) Playback (`components/NowPlayingScreen.tsx`)
VTS podcasts embed `<podcast:valueTimeSplit>` segments that map time ranges to different tracks/artists. `NowPlayingScreen` resolves the active VTS segment based on current playback position and uses it for:

- **Chapter tick marks** on the progress bar — thin white lines at each VTS/chapter boundary
- **Per-song favoriting** — uses VTS `remoteItem` (feedGuid + itemGuid) to favorite the current segment's track, not the parent episode
- **V4V blending** — VTS `remotePercentage` splits payment between song recipients and show-level recipients, deduped by Lightning address. `isHost` flag distinguishes show vs song recipients.
- **GUID collision detection** — `chapterTitle` param sent to `/api/lightning/value-splits` validates DB matches against chapter context. If track title/artist don't appear in chapter title, the match is discarded and PI API fallback used.

**VTS extraction** (`lib/rss-parser-db.ts`): `applyParsedItemFields` helper applies chapters, VTS, and other parsed fields to track upsert data. `refresh-by-url/route.ts` passes these fields through.

**VTS remoteItem interface** (`lib/podcast-types.ts`): includes `feedGuid`, `itemGuid`, `medium` fields.

### BoostButton V4V Display (`components/Lightning/BoostButton.tsx`)
When VTS blending produces both song and show recipients, BoostButton shows **Song/Show section headers** with recipients sorted track-first. Percentages are normalized to sum to 100% within the displayed split list. `isHost` prop on value splits controls grouping.

### Helipad Metadata (`components/Lightning/BoostButton.tsx`)
Built by `buildHelipadMetadata(amount, msg)`, BLIP-0010 spec. Single helper for all payment paths — do NOT duplicate. `name` field omitted from base; `value-splits.ts` sets it per-recipient.

**BoostButton props**: `feedUrl`, `remoteFeedGuid` (must be real GUID, never feed slug/ID), `albumName`, `publisherGuid`, `episodeGuid` (omit for album-level). Do NOT fall back to `feedId` for `remoteFeedGuid` — it's a slug, not a GUID.

### Episode/Play Count Markers
`<podcast:txt purpose="episode">` or `<podcast:txt purpose="playcount">` in XML. Parser decodes XML entities (`&apos;` `&quot;` `&amp;` etc.) via `decodeXmlEntities()` in `lib/playlist/parser.ts`. Original titles stored in `SystemPlaylistTrack.episodeTitle` column — do NOT reverse-engineer titles from episode IDs (lossy). Refresh: `curl https://stablekraft.app/api/playlist/[id]?refresh`

### Daily Workflow Playlists
The `PLAYLISTS` array in `.github/workflows/refresh-playlists.yml` must include ALL playlist IDs. Missing playlists won't get nightly feed discovery, reparsing, or publisher imports.
