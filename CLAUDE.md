# Stablekraft App

## Commands
```
npm run dev          # Start dev server
npm run build        # Build for production
npm run db:studio    # Open Prisma Studio
npm run deploy       # Deploy via script
```

## Boundaries
- Never commit secrets (`.env`, API keys)
- Run `npm run build` before committing

## Tech Stack
- Next.js 15 (App Router), React 18, TypeScript, PostgreSQL/Prisma
- Podcast Index API for feed resolution (not Wavlake)
- Nostr for auth, Lightning (Alby/WebLN) for payments

## Architecture

### Two-Repo Setup
- **musicL-playlist-updater** - Generates playlist XML feeds
- **stablekraft-app** (this repo) - Consumes and displays playlists

### Daily Workflow (`.github/workflows/refresh-playlists.yml`)
Runs at 4 AM EST: clears cache -> reparses feeds -> refreshes playlists -> parses publishers

## Key Behaviors

### Playlist Resolution
Playlists use `<podcast:remoteItem>` with `feedGuid` + `itemGuid`. On `?refresh`:
1. Find feeds without tracks, parse immediately
2. Discover missing feeds via Podcast Index API
3. Parse new feeds (imports tracks + V4V data)
4. Discover/link publisher feeds

**Feed import with duplicate IDs**: Podcast Index uses numeric IDs (`6876105`) while our DB uses GUIDs (`b2048129-...`). When `importFeedToDatabase` finds a URL already exists under a different ID, it redirects to the existing feed and imports tracks into it (previously it returned early with 0 tracks — fixed in `lib/feed-parsing.ts`).

**Image URL validation**: Track images are validated in `lib/playlist/resolver.ts` — bare domain URLs (e.g., `http://thebearsnare.com`) are rejected, falling back to the feed-level image.

**Resolution Limitations** (expect 80-90% resolution rate):
- **Dead feeds**: Some `feedGuid` entries exist in Podcast Index but have no URL (feed removed/dead)
- **Duplicate GUIDs**: Same song published on multiple platforms (Wavlake vs original publisher) has different `itemGuid` values - playlist may reference one version while database has another
- **Duplicate URLs**: Two different `feedGuid` values can point to the same feed URL - handled by checking URL before insert to avoid constraint errors

### Admin Feed Management (`/admin`)
Single input handles both add and reparse:
- New feeds -> added and parsed automatically
- Existing feeds -> reparsed to update content
- Auto-detects type from URL (`-pubfeed` = publisher)

### Search
- Uses PostgreSQL trigram `similarity()` for fuzzy matching
- Artist search groups by `LOWER(artist)` to avoid case duplicates
- Exact mode: `?fuzzy=false`

### Publisher Pages
Matched by: title slug, artist slug, or URL path (e.g., `/setto/` matches "setto")
- `<podcast:podroll>` sections filtered out (not albums)
- `-pubfeed.xml` URLs skipped

### Duration Filtering
Tracks over 2 hours filtered as non-music (silent, no warnings)

### NIP-46 Remote Signer (Amber)
iOS Safari kills WebSocket connections after ~30 seconds when backgrounded. The NIP-46 client handles this with:
- **Proactive reconnection**: `visibilitychange` listener in `useNip46Connection.ts` triggers reconnection when app returns to foreground
- **Platform-aware thresholds**: iOS uses 15s staleness threshold, other platforms use 60s
- **Key files**: `lib/nostr/nip46-client.ts` (client + thresholds), `components/Nostr/hooks/useNip46Connection.ts` (visibility handler)

### iOS PWA Background Audio
iOS aggressively suspends audio when the PWA is backgrounded. Key mechanisms in `contexts/AudioContext.tsx`:

- **Silent keepalive**: Plays inaudible audio to keep the audio session alive when backgrounded
- **Visibility handlers**: `visibilitychange` and `pageshow` events detect foreground/background transitions
- **User pause tracking**: `userInitiatedPauseRef` tracks explicit user pauses (lock screen controls)
- **Was playing tracking**: `wasPlayingBeforeHiddenRef` tracks if audio was playing before backgrounding

**Critical behavior**:
- `pause()` sets `userInitiatedPauseRef = true`, clears `wasPlayingBeforeHiddenRef`, and stops keepalive
- `resume()` clears `userInitiatedPauseRef` and restarts keepalive
- Visibility handlers check BOTH flags before auto-resuming: `wasPlayingBeforeHiddenRef && !userInitiatedPauseRef`
- This prevents lock screen pause from being overridden when unlocking the phone

### Sorting
Main page sorting available on filtered views (Albums, EPs, Singles, Publishers):
- **Name**: A-Z / Z-A alphabetical
- **Year**: Newest/Oldest by `oldestItemPubdate` (actual release date from tracks)
- **Added**: Newest/Oldest by `createdAt` (when added to site)
- **Tracks**: Most/Least track count

Date fields:
- `Feed.oldestItemPubdate` - Album release date. Backfill: `POST /api/admin/backfill-oldest-pubdate`
- `Feed.createdAt` - When added to site
- Publishers use oldest album's `createdAt` as their `dateAdded`

### Adding New Playlists
Files to modify (7 total):
1. `lib/playlist/configs.ts` - Add config entry with id, url, name, shortName, etc.
2. `app/api/playlist/[id]/route.ts` - Create main API route using `createPlaylistHandler`
3. `app/api/playlist/[id]-fast/route.ts` - Create fast API route for placeholder data
4. `lib/playlist-track-counts.ts` - Add to both `FALLBACK_COUNTS` and `PLAYLIST_URLS`
5. `app/api/playlists-fast/route.ts` - Add playlist summary to the array
6. `app/page.tsx` - Add to fallback `Promise.allSettled` array (~line 760)
7. `app/playlist/[id]/page.tsx` - Create dedicated playlist page

After code changes, populate database: `curl http://localhost:3000/api/playlist/[id]?refresh`

### Playlist Page UI
- All playlist pages use `PlaylistTemplateCompact` component
- Back button links to `/?filter=playlist` (the main page Playlists filter)
- Grouped view (episodes/play counts): `EpisodeSection.tsx` renders collapsible sections
- Tracks panel background: `bg-black/75` for readability over page backgrounds
- Track rows in grouped view: single-row horizontal layout with `bg-black/50`

### Nostr Publish Queue (`lib/nostr/publish-queue.ts`)
Favoriting a track saves to DB immediately, then queues the Nostr publish in the background. This prevents each click from opening 7+ WebSocket connections to relays.

- **`queueFavoritePublish()`** — enqueues a favorite, returns promise resolving with `nostrEventId`
- **`queueFavoriteDeletion()`** — enqueues a deletion event
- **`flushQueue()`** — 500ms debounce, creates ONE `RelayManager`, signs/publishes all queued events with 500ms inter-sign delay for NIP-46 rate limits
- **30s failure cooldown** — after total relay failure, stops retrying to avoid log spam
- After publish, FavoriteButton PATCHes the `nostrEventId` back to the DB
- `FavoriteButton.tsx` imports from publish queue, NOT from `favorites.ts` directly

**Flow**: `click → save to DB (no eventId) → queue Nostr publish → PATCH eventId when done`

### Relay Connection Management (`lib/nostr/relay.ts`)
- **5s connection timeout** — `RelayManager.connect()` wraps `Relay.connect()` with `Promise.race` (nostr-tools never passes timeout internally)
- **Always disconnect** — every `RelayManager` must call `disconnectAll()` after publishing, otherwise WebSocket connections leak and accumulate in the browser
- Per-relay connection warnings are suppressed; callers handle "0 successful connections" with a single summary log

### Favorites Page (`/favorites`)
- **Optimistic unfavorite** — `handleFavoriteToggle(trackId)` removes the track from local state immediately, no reload needed
- **Sync button coordination** — `SyncToNostrButton` listens for `'favorites-synced'` custom event to re-fetch its unpublished count. Event is dispatched by `useAutoSyncFavorites` after batch sync and by `FavoriteButton` after a queued publish PATCH succeeds.
- **Auto-sync** — `useAutoSyncFavorites` hook runs on page load (1.5s delay), batch-publishes unpublished favorites via `batchPublishFavoritesToNostr` in `favorites.ts`

### Nostr Playlist Publishing (`lib/nostr/playlist-events.ts`)
Favorites can be published as a kind 34139 addressable Nostr event via "Share to Nostr" button on the Tracks tab.

- **`createPlaylistEventTemplate()`** — builds unsigned event with `d` tag (`stablekraft-favorites`), title, `i` tags with podcast GUIDs
- **`publishPlaylistToNostr()`** — signs via unified signer, publishes to relays, returns `{ success, eventId, naddr }`
- **Addressable event** — re-publishing replaces previous version (same `d` tag, same `naddr`)
- **Track order** — uses `sortedTracks` (matches whatever sort the user has selected)
- **Title** — auto-generated from user's Nostr display name: `"{name}'s Favorite Tracks"`
- **`i` tags** — per-track `podcast:item:guid:{guid}` + deduplicated `podcast:guid:{feedGuid}` for Podcast Index resolution
- **WebSocket safety** — relay connections wrapped in `try/finally` to guarantee `disconnectAll()`
- **Key files**: `lib/nostr/playlist-events.ts`, `components/favorites/PublishPlaylistButton.tsx`, `components/favorites/PublishPlaylistModal.tsx`

### Favorite Publishers Resolution (`app/api/favorites/albums/route.ts`)
Publisher favorites can be stored with different feedId formats:
- **Synthetic artist IDs** (`artist-adam-curry`) — from main `/api/publishers` page, resolved by querying album feeds by artist name
- **Feed GUIDs** (`d7b4abee-...`) — looked up by `Feed.guid` column as fallback when `Feed.id` doesn't match
- **Feed IDs** (`wavlake-publisher-aa909244`) — direct DB match on `Feed.id`

**Image resolution chain**: DB feed image → Podcast Index API artwork → album feed image by artist name. Publisher feeds often don't store artwork, so the album feed fallback is essential.

**Album count**: Case-insensitive artist name matching against non-publisher feeds. Falls back to the publisher feed's own Track count (album references) when artist matching finds 0.

**NIP-51 republish**: Excluded for publisher favorites (`type: { not: 'publisher' }`) in both `unpublished-count` and `sync-to-nostr` APIs. Tracks and albums still support NIP-51 republishing.

### BackButton Component (`components/BackButton.tsx`)
Uses `window.history.length` to detect if there's a page to go back to. Falls back to `router.push(href)` (default `/`) only when `history.length <= 1` (direct link with no prior navigation). Do NOT use `document.referrer` — it doesn't update during SPA/client-side navigation.

### Episode/Play Count Markers
Playlists can include `<podcast:txt purpose="episode">` or `<podcast:txt purpose="playcount">` markers in XML. These group tracks into collapsible sections:
- **Parser** (`lib/playlist/parser.ts`): Extracts markers via regex, assigns `episodeTitle`/`episodeId` to tracks
- **Resolver** (`lib/playlist/resolver.ts`): Passes episode context through to resolved tracks
- **Display**: `EpisodeSection.tsx` (grouped view), amber badges in flat view
- After adding markers to XML, refresh the playlist: `curl https://stablekraft.app/api/playlist/[id]?refresh`
