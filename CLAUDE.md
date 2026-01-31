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
