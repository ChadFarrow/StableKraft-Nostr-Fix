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
