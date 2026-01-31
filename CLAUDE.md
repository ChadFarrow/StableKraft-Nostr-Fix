# Stablekraft App

## Commands

### Development
npm install          # Install dependencies
npm run dev          # Start dev server
npm run build        # Build for production
npm run start        # Start production server

### Database
npm run db:generate  # Generate Prisma client
npm run db:migrate   # Run migrations (production)
npm run db:migrate:dev  # Run migrations (dev)
npm run db:studio    # Open Prisma Studio
npm run db:push      # Push schema changes

### Deployment
npm run deploy       # Deploy via script
npm run auto-deploy  # Auto-deploy with version bump

### Utilities
npm run test-feeds   # Test RSS feed parsing
npm run fix-all      # Run all fix scripts
npm run update-music # Update music workflow

## Boundaries

- Never commit secrets or credentials (`.env`, API keys, passwords)
- Run `npm run build` before committing to catch errors

## Project Structure

stablekraft-app/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   ├── album/             # Album pages
│   ├── playlist/          # Playlist pages
│   ├── publisher/         # Publisher pages
│   ├── favorites/         # User favorites
│   ├── library/           # User library
│   ├── search/            # Search functionality
│   ├── settings/          # User settings
│   └── radio/             # Radio feature
├── components/            # React components
│   ├── favorites/
│   ├── Lightning/
│   ├── Nostr/
│   ├── Radio/
│   └── Settings/
├── contexts/              # React contexts
├── lib/                   # Shared libraries
│   ├── api/
│   ├── hooks/
│   ├── lightning/
│   ├── nostr/
│   ├── playlist/
│   └── rss-parser/
├── prisma/                # Database schema & migrations
├── public/                # Static assets
├── scripts/               # Utility scripts
└── types/                 # TypeScript types

## Tech Stack

### Core
- Next.js 15.5.9 (App Router)
- React 18
- TypeScript 5
- Node.js >= 18.0.0

### Database
- PostgreSQL
- Prisma 6.16.2

### Styling
- Tailwind CSS 3.4.19

### Integrations
- Podcast Index API - Feed resolution and track lookup
- nostr-tools 2.15.0 - Nostr protocol for auth/social
- @getalby/bitcoin-connect 3.11.0 - Lightning wallet
- WebLN 0.3.2 - Lightning payments
- HLS.js 1.6.7 - Audio streaming

### Infrastructure
- Bunny CDN (re-podtards-cdn.b-cdn.net)
- PM2 (process manager)
- next-pwa 5.6.0 (offline support)
- Capacitor 7.4.2 (Android builds)

## Git Workflow

### Branches
- `main` - Production branch

### GitHub Actions
- **Refresh Playlists** (`.github/workflows/refresh-playlists.yml`)
  - Runs daily at 4 AM EST (9 AM UTC)
  - Refreshes playlist cache
  - Reparses music feeds for new tracks
  - Parses publisher feeds for album relationships

### Workflow Steps
1. Clear playlist cache (`/api/playlist-cache?refresh=all`)
2. Reparse all music feeds (`/api/admin/reparse-feeds`)
3. Refresh each playlist (`/api/playlist/{id}?refresh=true`)
4. Parse newly discovered feeds (`/api/playlist/parse-feeds`)
5. Parse publisher feeds (`/api/parse-feeds?action=parse-publishers`)
6. Final playlist refresh to include new tracks

### Two-Repo Architecture
- **musicL-playlist-updater** - Generates playlist XML feeds (separate repo)
- **stablekraft-app** (this repo) - Consumes and displays playlists

## API Notes

- Always use Podcast Index API for feed lookups (not Wavlake)
- API keys: `PODCASTINDEX_API_KEY`, `PODCASTINDEX_API_SECRET` in `.env`
- Docs: https://podcastindex-org.github.io/docs-api/#overview
- Playlists use `<podcast:remoteItem>` tags with `feedGuid` and `itemGuid`
- All feeds must be parsed before they can be displayed

## Playlist Feed Resolution

Playlists reference tracks via `feedGuid` + `itemGuid` in XML. The resolution flow:

### On Refresh (`?refresh`)
1. **Pre-resolution check**: Find feeds that exist but have no tracks, parse them immediately
2. **Initial resolution**: Query database for tracks by GUID
3. **Discovery**: For unresolved tracks, discover missing feeds via Podcast Index API
4. **Immediate parsing**: Parse newly discovered feeds (imports all album tracks + V4V data)
5. **Publisher discovery**: Check album XML for publisher references, add/link publishers
6. **Re-resolution**: Query again to include newly imported tracks

### Key Files
- `lib/feed-parsing.ts` - Shared utilities for parsing feeds via Podcast Index API
- `lib/feed-discovery.ts` - Feed discovery, parsing, and publisher linking
- `lib/playlist/handler.ts` - Playlist request handler with immediate parsing
- `lib/publisher-discovery.ts` - Publisher feed discovery and album linking

### Functions
- `findUnparsedFeeds(guids)` - Find feeds missing tracks
- `parsePlaylistFeeds(guids)` - Parse feeds immediately, import all tracks
- `discoverAndParsePublishers(feedIds)` - Discover and link publisher feeds
- `parseFeedByGuid(guid)` - Parse single feed via Podcast Index API

### Fix: Missing Playlist Tracks (Jan 2026)

**Problem**: Playlists showed fewer tracks than expected (e.g., HGH Episode 121 showed 6 of 13 tracks).

**Root Cause**: When playlists were refreshed, newly discovered feeds were added to the database but not parsed until the nightly workflow ran. Tracks couldn't resolve because they didn't exist yet.

**Solution**: Implemented immediate feed parsing during `?refresh`:
1. After discovering missing feeds, parse them immediately (not waiting for nightly job)
2. Import all tracks from each album with full metadata (title, audio URL, duration, V4V data)
3. Discover and link publisher feeds for newly added albums
4. Re-resolve tracks so they appear in the same request

**Edge Case**: Some feeds exist in Podcast Index under different IDs than their `feedGuid`. When a feed URL changes, Podcast Index may create a new entry with a different ID. The fix handles this by:
- Looking up feeds by GUID via Podcast Index API
- Using the resolved feed data (including updated URLs) for parsing
- Storing tracks with their correct GUIDs for future resolution

**Result**: All playlist tracks now resolve on first refresh. HGH Episode 120 (10 tracks) and Episode 121 (13 tracks) fully resolved.

## Admin Feed Management

### Admin Page (`/admin`)
Single smart input for managing feeds:
- **New feeds** → automatically added and parsed (metadata, tracks, V4V data)
- **Existing feeds** → automatically reparsed to update content
- **Auto-detects** feed type from URL patterns (`-pubfeed` = publisher, `/artist/` = publisher)

### Key Endpoints
- `POST /api/admin/feeds` - Add feed with auto-parse
- `POST /api/feeds/refresh-by-url` - Reparse existing feed by URL
- `POST /api/admin/feeds/[id]/reparse` - Reparse feed by ID
- `POST /api/admin/reparse-feeds?type=publisher` - Bulk reparse publisher feeds

### Duration Validation
`lib/duration-validation.ts` filters out non-music content:
- Tracks over 2 hours (7200s) are considered podcasts, not music
- Duration is set to `undefined` for these tracks (falls back to 180s default)
- No console warnings logged (silent filtering)
