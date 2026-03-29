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
Runs at 4 AM EST: clears cache -> reparses feeds -> refreshes playlists -> parses publishers -> imports missing albums from publisher feeds (Step 5b via PI API). The `PLAYLISTS` array must include ALL playlist IDs — missing ones won't get nightly processing.

## Key Behaviors

### Playlist Resolution
Playlists use `<podcast:remoteItem>` with `feedGuid` + `itemGuid`. On `?refresh`: discover feeds via PI API → parse → discover publishers → resolve tracks. Resolution rate ~80-90%.

**Feed deduplication pattern**: multi-check dedup (normalized URL, raw URL, feedGuid as ID, feedGuid as GUID column, feedGuid-in-URL substring, then secondary `podcastGuid` check). New feeds get slug-based IDs via `generateAlbumSlug`. When modifying feed import code, follow this pattern — weak dedup causes duplicate entries.

**Podcast type detection**: Non-Wavlake feeds with `<podcast:medium>podcast</podcast:medium>` auto-detect as `type: 'podcast'` on import. Wavlake feeds are excluded from this (they use `medium=podcast` for music). Feeds with `type: 'podcast'` auto-appear under the Podcasts filter and are excluded from the album grid. If mistyped feeds appear, run `POST /api/admin/fix-podcast-types`.

**PI API status gotcha**: `normalizeFeedResponse` in `lib/podcast-index-api.ts` must accept both `status: 'true'` (string) and `status: true` (boolean). Use `data.status !== 'true' && data.status !== true` for rejection checks.

**Podroll exclusion**: `process-remote-items/route.ts` strips `<podcast:podroll>` sections before extracting `<podcast:remoteItem>` tags. Without this, podroll-referenced feeds get imported as albums.

### Feed Blacklist (`lib/feed-exclusions.ts`)
Central exclusion config: `BLACKLISTED_FEED_IDS`, `BLACKLISTED_FEED_URLS`. Helpers: `isBlacklistedFeedId()`, `isBlacklistedFeedUrl()`.

### Admin Feed Management (`/admin`)
Single input handles both add and reparse. Auto-detects type from URL (`-pubfeed` = publisher). **Fixing duplicates**: delete all copies first (`DELETE /api/feeds?id=<feedId>`), then re-add. Initial import (`POST /api/feeds`) saves all parsed fields including chapters, VTS, and V4V via `applyParsedItemFields()` — no reparse needed.

### Adding Music Podcasts (like Upbeats, Two For Tunestr)
Import feed via `/admin` page (paste RSS URL). Non-Wavlake feeds with `<podcast:medium>podcast</podcast:medium>` automatically get `type: 'podcast'`, appear under the Podcasts filter, hide from the album grid, and are searchable — no config file edits needed. `/podcast/[id]` dynamic route handles display, episodes sort newest-first.

**Slug redirects**: If the auto-generated feed ID differs from the desired URL slug (e.g., `silvie-two-for-tunestr` vs `two-for-tunestr`), add mappings to `PODCAST_SLUG_TO_FEED_ID` and `PODCAST_CANONICAL_SLUGS` in `lib/podcast-feeds.ts`.

**After import**: Reparse the feed from the admin page to ensure chapters and VTS are populated (the initial import may miss them if the chapters proxy is down).

### Search
- PostgreSQL trigram `similarity()`, flat 0.3 threshold. Do NOT lower below 0.3 — causes false positives.
- Artist search groups by `LOWER(artist)`. Exact mode: `?fuzzy=false`
- Podcasts searchable by title/artist/description (queries `type: 'podcast'` feeds)

### Publisher Pages (`app/publisher/[id]/page.tsx`)
Matched by: title slug, artist slug, or URL path. Multi-feed support with per-platform sections. Album resolution: (1) GUIDs/URLs from publisher feed XMLs → (2) `publisherId`-linked albums → (3) artist name matching. Do NOT re-add platform filters — hides legitimate cross-platform albums.

### Duration Filtering
Tracks over 2 hours filtered as non-music (silent, no warnings)

### NIP-46 Remote Signer (Amber / Primal)
Key files: `lib/nostr/nip46-client.ts`, `components/Nostr/hooks/useNip46Connection.ts`. iOS Safari kills WebSocket connections after ~30s backgrounded; reconnects on `visibilitychange`. **Primal is the best iOS signer** — auto-signs with Full trust, responds <1s. Performance optimizations (adaptive rate limiting, pre-decrypted content, smart subscription filters, keypair cache) are gated behind `localStorage.setItem('nip46_debug', 'true')` for debug logging.

### iOS PWA Background Audio (`contexts/AudioContext.tsx`)
Three-layer strategy: (1) preload at 15s before end, (2) proactive timer at 5s before end, (3) visibility change safety net. `trackEndProcessedRef` prevents double-advance. **Critical**: do not auto-resume if user explicitly paused.

### Sorting
`/api/albums-fast` accepts `sort` param (`added-desc`, `added-asc`, `year-desc`, `year-asc`, `name-asc`, `name-desc`, `tracks-desc`, `tracks-asc`). **Do NOT send `sort=name-asc` as default** — it bypasses format grouping (Albums → EPs → Singles). Date fields: `Feed.oldestItemPubdate` = release date, `Feed.createdAt` = when added.

### Adding New Playlists
Files to modify (9 total):
1. `lib/playlist/configs.ts` - Config entry
2. `app/api/playlist/[id]/route.ts` - Main API route
3. `app/api/playlist/[id]-fast/route.ts` - Fast API route
4. `lib/playlist-track-counts.ts` - `FALLBACK_COUNTS` and `PLAYLIST_URLS`
5. `app/api/playlists-fast/route.ts` - Playlist summary
6. `app/page.tsx` - Fallback `Promise.allSettled` array
7. `app/playlist/[id]/page.tsx` - Dedicated page (`PlaylistTemplateCompact`)
8. `app/favorites/page.tsx` - `playlistTitles`, `playlistImageFallbacks`, `playlistSlugOverrides`
9. `.github/workflows/refresh-playlists.yml` - Add to `PLAYLISTS` array

Populate: `curl https://stablekraft.app/api/playlist/[id]?refresh`

### Nostr Publish Queue & Relay Management
Favoriting saves to DB immediately, queues Nostr publish (500ms debounce). **Always call `disconnectAll()`** after publishing or WebSocket connections leak. Key files: `lib/nostr/publish-queue.ts`, `lib/nostr/relay.ts`.

### Favorites Page (`/favorites`)
Optimistic unfavorite, auto-sync on page load. **Playlist favorites gotcha**: `isPlaylist()` and `playlistImageFallbacks` must use **lowercased feedId**, not the human name. `playlistSlugOverrides` handles ID-to-slug mismatches. Nostr playlist publishing: Kind 34139 addressable event (`d` tag = `stablekraft-favorites`).

### Favorite Publishers Resolution (`app/api/favorites/albums/route.ts`)
Three feedId formats: synthetic artist IDs (`artist-adam-curry`), feed GUIDs, feed IDs. Image chain: DB → PI API → album feed image by artist name.

### BackButton (`components/BackButton.tsx`)
Uses `window.history.length`. Do NOT use `document.referrer` — doesn't update during SPA navigation.

### Lightning Wallet Detection
Keysend inferred from provider type (`hasKeysendMethod && type !== 'unknown'`). Do NOT probe with real keysend — triggers payment popup. Alby extension detection: `detectWalletProviderType()` in `lib/lightning/wallet-detection.ts`.

### BoostBox & Helipad (`lib/lightning/boostbox.ts`)
LNURL payments use [BoostBox](https://tardbox.com) for Podcasting 2.0 boost metadata. Keysend unaffected (uses Helipad TLV). Client-only — always uses `/api/lightning/boostbox` proxy (API key via `BOOSTBOX_API_KEY` env var). Value splits try keysend first; BoostBox called only for LNURL fallback. Fountain.fm addresses skip keysend by design (`isFountain` check).

**Feed.guid gotcha**: `feed_guid` in BoostBox comes from `Feed.guid` in DB. If null, reparse the feed.

**Helipad metadata**: built by `buildHelipadMetadata(amount, msg)` in `BoostButton.tsx`, BLIP-0010 spec. Single helper for all payment paths — do NOT duplicate. `name` field omitted from base; `value-splits.ts` sets it per-recipient.

**BoostButton props**: `feedUrl`, `remoteFeedGuid` (must be real GUID, never feed slug/ID), `albumName`, `publisherGuid`, `episodeGuid` (omit for album-level). Do NOT fall back to `feedId` for `remoteFeedGuid` — it's a slug, not a GUID.

### VTS (Value Time Splits) Playback (`components/NowPlayingScreen.tsx`)
VTS podcasts embed `<podcast:valueTimeSplit>` segments that map time ranges to different tracks/artists. Features: chapter tick marks on progress bar, per-song favoriting via `remoteItem`, V4V blending (`remotePercentage` splits between song and show recipients, deduped by address, `isHost` flag for grouping). GUID collision detection via `chapterTitle` param to `/api/lightning/value-splits`. When VTS blending produces both song and show recipients, BoostButton shows **Song/Show section headers** sorted track-first.

**VTS extraction** (`lib/rss-parser-db.ts`): `applyParsedItemFields` applies chapters, VTS, and other parsed fields to track data. **VTS remoteItem interface** (`lib/podcast-types.ts`): `feedGuid`, `itemGuid`, `medium`. **XML entity gotcha**: `parseItemV4VFromXML` matches titles against raw XML — titles with `&` (encoded as `&amp;`) need both decoded and XML-encoded matching.

**Chapters fallback**: `fetchChapters()` fetches from `podcast:chapters` URL. If the `reflex.livewire.io` proxy returns 400, it extracts the direct URL from the proxy path (format: `.../chapters/https://actual-url.json`) and retries.

### AutoBoost (`contexts/AudioContext.tsx`)
Two paths gated by `autoBoostEnabled` setting and `autoBoostProcessingRef` mutex:
- **`triggerAutoBoost`** — track end for non-VTS tracks. Falls back from track-level to album-level V4V.
- **`triggerChapterAutoBoost`** — VTS segment transitions. Fetches remote V4V, scales by `remotePercentage`, blends show-host recipients. Non-music chapters use show-level V4V only. API fallback via `feedGuid` if `album.v4vValue` is empty.

**Gap tracking** (`inVtsGapRef`): boosts music segments on gap entry, talk chapters on gap exit. Pre-VTS gaps (intro) tracked on track start. Track-end in a gap boosts via `triggerChapterAutoBoostRef` in `handleEnded`. **Manual seek suppression** (`isManualSeekRef`): chapter skips/progress bar don't trigger autoboost, only natural playback. **iOS foreground recovery**: `visibilitychange`/`pageshow` detect and boost missed segments.

### Episode/Play Count Markers
`<podcast:txt purpose="episode">` or `<podcast:txt purpose="playcount">` in XML. Parser decodes XML entities via `decodeXmlEntities()` in `lib/playlist/parser.ts`. Original titles stored in `SystemPlaylistTrack.episodeTitle` — do NOT reverse-engineer from episode IDs (lossy). Refresh: `curl https://stablekraft.app/api/playlist/[id]?refresh`
