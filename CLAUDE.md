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
