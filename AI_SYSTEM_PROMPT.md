# Stablekraft App - AI System Prompt

You are an AI assistant helping develop and maintain the Stablekraft app, a decentralized music streaming platform powered by RSS feeds, Nostr, and the Lightning Network.

---

## App Overview

**Stablekraft** is a music discovery and streaming application that:
- Extracts music tracks from podcast RSS feeds using the Podcast Index API
- Streams audio with full player controls (shuffle, repeat, background playback)
- Manages curated playlists (MMM, HGH, ITDV, IAM, SAS, MMT, B4TS, Upbeats)
- Enables Bitcoin Lightning payments ("boosts") to artists via Value4Value (V4V)
- Uses Nostr for authentication, favorites sync, and social features (zaps)
- Provides album browsing, publisher pages, and fuzzy search

---

## Two-Repo Architecture

This project uses a separation of concerns with two repositories:

### 1. Playlist Generator (musicL-playlist-updater)
- **Repo**: https://github.com/ChadFarrow/musicL-playlist-updater
- **Purpose**: Generates and updates playlist XML feeds
- **Output**: https://github.com/ChadFarrow/chadf-musicl-playlists
- **Schedule**: Runs daily via GitHub Actions

### 2. This Repo (stablekraft-app)
- **Purpose**: Consumes playlist feeds and displays them in the app
- **Does NOT generate playlists** - only fetches and caches them
- **Feed Sync**: Daily at 2 AM UTC via `.github/workflows/refresh-playlists.yml`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Database | PostgreSQL with Prisma ORM |
| Authentication | Nostr (NIP-07, NIP-46, NIP-55) |
| Payments | WebLN, LNURL, Lightning Network, Keysend |
| RSS Parsing | rss-parser, fast-xml-parser, Podcast Index API |
| Image Processing | Sharp, color-thief |
| Frontend | React 18, Tailwind CSS, Lucide icons |
| PWA | next-pwa with service workers |
| Audio | HLS.js for streaming, Web Audio API |

---

## Directory Structure

```
stablekraft-app/
├── app/
│   ├── api/                    # ~95+ API routes
│   │   ├── playlist/           # Playlist endpoints (mmm, hgh, itdv, etc.)
│   │   ├── tracks/             # Track listing and search
│   │   ├── feeds/              # Feed management
│   │   ├── admin/              # Admin operations (Nostr auth protected)
│   │   ├── lightning/          # Boost payments, lnurl, value splits
│   │   ├── nostr/              # Auth challenge, login, activity
│   │   └── parse-feeds/        # Playlist parsing workflow
│   ├── album/[id]/             # Album detail pages
│   ├── publisher/[id]/         # Publisher/artist pages
│   ├── playlist/               # Playlist views
│   └── layout.tsx              # Root layout with context providers
│
├── lib/
│   ├── lightning/              # WebLN, LNURL, value splits, keysend
│   ├── nostr/                  # Client, signer, auth, favorites, zaps
│   ├── music-track-parser/     # RSS parsing and track extraction
│   ├── rss-parser/             # RSS/Podcast feed parsing
│   ├── podcast-index-api.ts    # Podcast Index API client
│   ├── v4v-resolver.ts         # Value4Value resolution
│   ├── fuzzy-search.ts         # Search with pg_trgm
│   └── prisma.ts               # Prisma client singleton
│
├── components/
│   ├── GlobalNowPlayingBar.tsx # Persistent audio player
│   ├── NowPlayingScreen.tsx    # Full-screen now playing
│   ├── PlaylistTemplate.tsx    # Unified playlist view
│   ├── BoostButton.tsx         # Lightning payment UI
│   ├── CDNImage.tsx            # Optimized image loading
│   ├── Lightning/              # Lightning components
│   ├── Nostr/                  # Nostr auth components
│   └── favorites/              # Favorite button components
│
├── contexts/
│   ├── AudioContext.tsx        # Global audio player state
│   ├── NostrContext.tsx        # Nostr auth state
│   ├── LightningContext.tsx    # Lightning wallet state
│   ├── UserSettingsContext.tsx # User preferences
│   └── BatchedFavoritesContext.tsx # Favorites batching
│
├── types/                      # TypeScript type definitions
├── prisma/schema.prisma        # Database schema
└── scripts/                    # Automation scripts
```

---

## Database Schema (Key Models)

### Track
Music tracks extracted from RSS feeds.
```
- id, guid, title, artist, album, audioUrl, duration
- itunesAuthor, itunesSummary, itunesImage
- v4vRecipient, v4vValue (JSON) - Lightning payment data
- feedId (FK to Feed), status, trackOrder
```

### Feed
RSS feeds representing albums or artists.
```
- id, guid, title, description, originalUrl, cdnUrl
- type (album/artist), artist, image
- status (active/inactive), lastFetched
- v4vRecipient, v4vValue (JSON)
- publisherId (FK to Feed for artist relationship)
```

### User
Nostr-authenticated users.
```
- id, nostrPubkey, nostrNpub
- displayName, avatar, lightningAddress
- relays (string array)
```

### FavoriteTrack / FavoriteAlbum
User favorites (supports both session-based and Nostr-authenticated).
```
- userId, trackId/feedId, sessionId
- nostrEventId, nip51Format (Nostr list storage)
```

---

## Critical API Endpoints

### Playlists
- `GET /api/playlist/{type}` - Get playlist (mmm, hgh, itdv, top100, b4ts, sas, iam, mmt, upbeats)
- `POST /api/playlist/parse-feeds` - Import/parse new tracks from feeds
- `POST /api/playlist-cache?refresh=all` - Clear all caches

### Tracks & Feeds
- `GET /api/tracks` - List tracks with search/filters/pagination
- `GET /api/feeds/[id]` - Get feed details
- `POST /api/feeds/[id]/refresh` - Refresh individual feed
- `POST /api/admin/feeds/[id]/reparse` - Reparse feed from source

### Lightning Payments
- `POST /api/lightning/boost` - Send boost payment
- `GET /api/lightning/value-splits` - Get V4V payment splits
- `GET /api/lightning/lnurl/resolve` - Resolve LNURL

### Nostr
- `POST /api/nostr/auth/challenge` - Get auth challenge
- `GET /api/nostr/auth/me` - Get current user
- `POST /api/nostr/auth/logout` - Logout

---

## Feed Consumption Workflow

1. **GitHub Actions** runs daily at 2 AM UTC (`.github/workflows/refresh-playlists.yml`)
2. Calls `/api/playlist-cache?refresh=all` to clear cache
3. Calls each playlist endpoint with `?refresh=true` parameter
4. Calls `/api/playlist/parse-feeds` to import new tracks to database
5. Tracks are stored in PostgreSQL with V4V payment data

### Track Resolution (2-Phase)
1. **Database lookup** - Check if track already exists (fast)
2. **Podcast Index API** - Resolve missing tracks using `feedGuid` + `itemGuid` (slower)
3. Filter out tracks without valid `audioUrl` (unavailable content)

---

## Podcast Index API

**CRITICAL**: Always use the Podcast Index API to look up and parse RSS feeds.
- API keys are in `.env` (check for `PODCASTINDEX_API_KEY` and `PODCASTINDEX_API_SECRET`)
- Documentation: https://podcastindex-org.github.io/docs-api/
- Client implementation: `lib/podcast-index-api.ts`

Playlists use `<podcast:remoteItem>` tags with `feedGuid` and `itemGuid` attributes to reference tracks.

---

## Nostr Integration

### Authentication Methods
- **NIP-07**: Browser extension (Alby, nos2x)
- **NIP-46**: Remote signer / bunker connection
- **NIP-55**: Android app integration

### Features
- User authentication and session management
- Favorites sync to Nostr lists (NIP-51)
- Zaps (Nostr Lightning payments)
- Now-playing status publishing (NIP-38)
- Musician tagging in boost posts

### Key Files
- `lib/nostr/client.ts` - Core Nostr client
- `lib/nostr/signer.ts` - NIP-07/NIP-46/NIP-55 signing
- `lib/nostr/auth-utils.ts` - Authentication logic
- `lib/nostr/favorites.ts` - Favorites sync
- `components/Nostr/LoginModal.tsx` - Multi-method auth UI

---

## Lightning / V4V Integration

### Payment Methods
- **WebLN**: Browser wallet integration
- **LNURL**: Lightning URL protocol
- **Keysend**: Direct node payments (Coinos now supports this)

### V4V Workflow
```
Track → hasV4V() check → getV4VRecipients() → ValueSplitsService
   ↓
BoostButton displays split details
   ↓
Payment execution with progress tracking
   ↓
Publish to Nostr with musician p-tags
```

### Key Files
- `lib/lightning/webln.ts` - WebLN wallet integration
- `lib/lightning/lnurl.ts` - LNURL support
- `lib/lightning/value-splits.ts` - V4V payment distribution
- `lib/v4v-resolver.ts` - Value4Value resolution
- `components/BoostButton.tsx` - Payment UI (66KB, largest component)

---

## Audio Player Architecture

### AudioContext (`contexts/AudioContext.tsx`)
Central state management for audio playback (~3400+ lines):
- Current playing album and track
- Playback state (playing, loading, shuffle, repeat)
- Controls (play, pause, seek, next, previous)
- Prefetches upcoming tracks
- Supports audio and video playback
- Publishes now-playing to Nostr

### Key Components
- `GlobalNowPlayingBar.tsx` - Fixed bottom bar
- `NowPlayingScreen.tsx` - Full-screen player with artwork, controls, V4V

---

## UI Patterns & Performance

### Context Providers (wrap app in layout.tsx)
- AudioProvider - Global audio state
- NostrProvider - Authentication
- BatchedFavoritesProvider - Optimized favorites checking
- LightningWrapper - Bitcoin Connect integration
- UserSettingsProvider - User preferences

### Performance Optimizations
- **Memoization**: AudioContext value, AlbumCard
- **Dynamic imports**: Heavy components loaded on-demand
- **Intersection Observer**: Smart prefetching
- **Batched API calls**: Favorites status checking
- **Image optimization**: CDN, proxy, lazy loading
- **Debouncing**: Search queries

---

## Common Development Tasks

### Adding a New Playlist
1. Create endpoint at `app/api/playlist/{name}/route.ts`
2. Add to playlist generator repo (musicL-playlist-updater)
3. Update parse-feeds workflow to include new playlist
4. Add UI route at `app/playlist/{name}/page.tsx`

### Debugging Feed Parsing Issues
1. Check Podcast Index API for feed availability
2. Verify `feedGuid` and `itemGuid` are valid
3. Check `lib/music-track-parser/` for extraction logic
4. Use admin panel or `/api/admin/feeds/[id]/reparse`

### Working with V4V Payments
1. V4V data comes from podcast:value tags in RSS
2. Check `lib/v4v-resolver.ts` for resolution logic
3. `lib/lightning/value-splits.ts` handles payment distribution
4. BoostButton component manages UI and payment flow

### Nostr Authentication
1. LoginModal supports multiple methods (NIP-07, NIP-46, NIP-55)
2. NostrContext manages user state
3. Favorites sync uses NIP-51 lists
4. Zaps use NIP-57 protocol

---

## Important Conventions

1. **Always use Podcast Index API** instead of Wavlake website for feed info
2. **Expected behavior**: Some tracks from XML feeds may not resolve (API doesn't have them)
3. **Feed parsing is required** before any content displays in the app
4. **Coinos supports keysend** - this was recently added
5. **Repo was renamed** from FUCKIT to stablekraft-app
6. **All feeds need parsing** including publisher feeds

---

## Environment Variables

Located in `.env.local`:
```
PODCASTINDEX_API_KEY=...
PODCASTINDEX_API_SECRET=...
DATABASE_URL=postgresql://...
NOSTR_*=...                    # Various Nostr config
```

---

## Build & Development

```bash
npm run dev          # Development server
npm run build        # Production build (runs Prisma generate)
npm run db:migrate   # Run migrations
npm run db:push      # Push schema changes
npm run db:studio    # Open Prisma Studio
```

---

## Debugging Tips

1. **Track not appearing**: Check if feed is parsed, verify audioUrl exists
2. **V4V not working**: Check value block in RSS, verify Lightning addresses resolve
3. **Auth issues**: Check browser console for Nostr extension errors
4. **Playback issues**: Check HLS.js errors, verify audio URL accessibility
5. **Feed sync failing**: Check GitHub Actions logs, verify Podcast Index API keys

---

## Key Files Quick Reference

| Purpose | File |
|---------|------|
| Audio player state | `contexts/AudioContext.tsx` |
| Nostr client | `lib/nostr/client.ts` |
| Podcast Index API | `lib/podcast-index-api.ts` |
| V4V resolution | `lib/v4v-resolver.ts` |
| Feed parsing | `lib/music-track-parser/index.ts` |
| Playlist handling | `lib/api/playlist-handler.ts` |
| Lightning payments | `lib/lightning/webln.ts` |
| Database schema | `prisma/schema.prisma` |
| Root layout | `app/layout.tsx` |
| Now playing UI | `components/NowPlayingScreen.tsx` |
| Boost payments | `components/BoostButton.tsx` |
| Auth modal | `components/Nostr/LoginModal.tsx` |
