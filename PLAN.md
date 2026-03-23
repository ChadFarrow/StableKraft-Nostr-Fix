# Proposal: Music Podcast Support (Upbeats Test Branch)

## Goal

Add proper support for **music podcasts** — shows like [Upbeats](https://feeds.rssblue.com/upbeats) from [RSS Blue](https://rssblue.com/) where DJs play other artists' songs, using Podcasting 2.0 tags (`podcast:chapters`, `podcast:valueTimeSplit`, `podcast:remoteItem`) to identify tracks and route payments to the correct artists in real time.

**Test feed:** `https://feeds.rssblue.com/upbeats`
**Branch:** `claude/add-podcast-feed-sUR9X`

---

## What Works Today

- Feed import via `/admin` — paste URL, feed + tracks created
- `podcast:chapters` JSON fetched and parsed
- `podcast:valueTimeSplit` with `podcast:remoteItem` extracted
- Per-track V4V resolution via Podcast Index API
- BoostButton re-renders with new track's value data on track change (reactive `currentTrackIndex` → fresh props)
- Keysend + LNURL payment paths with BoostBox integration

## What's Broken or Missing

### 1. Chapter filtering rejects most music podcast chapters

**File:** `lib/music-track-parser/utils.ts:55-96`

`isMusicChapter()` requires either a music keyword ("song", "guitar", "remix", etc.) or an "Artist - Title" format. A chapter titled simply "Sunshine" or "Blue Sky" gets rejected. For a music podcast where **every chapter is a song**, this filter drops most tracks.

**Fix:** When the feed has `podcast:medium = "music"` or `"musicL"`, skip the music-keyword filter entirely — treat all chapters as music tracks (except those with `toc: false`).

### 2. `toc: false` chapters not respected

**Spec:** Chapters with `toc: false` are "silent" markers — metadata only, not displayed to users.

**File:** `lib/music-track-parser/index.ts:219-243`

Currently no check for `toc`. Silent chapters become visible tracks.

**Fix:** Add `toc` to `ChapterData` type, skip chapters where `toc === false`.

### 3. Chapter `img` field not mapped

**Spec:** The JSON chapters spec uses `img` for chapter art.
**Code:** `ChapterData` type uses `image`.

Real feeds from RSS Blue will use `img`. The chapter art won't load.

**Fix:** Map `img` → `image` during chapter JSON parsing, support both field names.

### 4. `endTime` defaults to +5 minutes instead of next chapter start

**File:** `lib/music-track-parser/index.ts:232`

When a chapter has no `endTime`, code defaults to `startTime + 300` (5 min). The spec implies chaining — one chapter ends when the next begins.

**Fix:** When `endTime` is missing, use the next chapter's `startTime`. Only use a fallback for the last chapter.

### 5. `remotePercentage` defaults to 0 instead of 100

**Spec:** If `remotePercentage` is not defined, it defaults to **100** — the remote artist gets everything (minus fees).

**File:** `lib/music-track-parser/extractors.ts:83`

Currently: `parseFloat(... || '0')` — remote artist gets 0%.

**Fix:** Change default to `'100'`.

### 6. `remoteStartTime` not captured

**Spec:** Sets the correct timestamp in value metadata sent to the remote recipient. Important for the receiving artist's podcast app to show accurate play position.

**File:** `lib/music-track-parser/extractors.ts` and `types.ts`

Not extracted or passed to Helipad metadata.

**Fix:** Parse `remoteStartTime` from VTS, store in `valueForValue`, include in Helipad metadata `ts` field.

### 7. VTS at `startTime: 0` skipped

**File:** `lib/music-track-parser/extractors.ts:58`

`if (startTime > 0 && ...)` — a song at position 0:00 (first track in the episode) is silently dropped.

**Fix:** Change to `startTime >= 0`.

### 8. Nested VTS not ignored per spec

**Spec:** When resolving a remote value block, ignore any `podcast:valueTimeSplit` children inside it. Only root-level splits apply.

**Fix:** Add a guard in the V4V resolver to strip nested VTS when fetching remote value blocks.

### 9. No "Podcasts" filter on the main page

**Current filters:** Albums (>= 6 tracks), EPs (2-5), Singles (1), Publishers, Playlists, Videos

Music podcasts imported as feeds have no dedicated filter tab. They'd show up mixed in with albums based on track count, which is misleading — a 50-episode podcast isn't an "album."

**Fix:** Add a `'podcasts'` filter option that filters by feed `type: 'podcast'` or feeds with `podcast:medium = "music"` / `"musicL"`. This separates music podcasts from albums in the UI while keeping them discoverable.

**Files:**
- `components/ControlsBar.tsx` — add "Podcasts" button to filter row
- `app/api/albums-fast/route.ts` — add `'podcasts'` filter case (filter by type or medium)
- `app/page.tsx` — handle `'podcasts'` filter state

---

## Implementation Plan

### Phase 1: Chapter Parsing Fixes (4 changes)

| # | File | Change |
|---|------|--------|
| 1a | `lib/music-track-parser/types.ts` | Add `toc?: boolean` and `img?: string` to `ChapterData` chapter type |
| 1b | `lib/music-track-parser/index.ts` | Map `img` → `image` in chapter JSON parsing; skip `toc: false` chapters; chain `endTime` to next chapter's `startTime` |
| 1c | `lib/music-track-parser/utils.ts` | Add `isMusicMediumFeed()` check; bypass `isMusicChapter()` keyword filter when feed medium is `music` or `musicL` |
| 1d | `lib/music-track-parser/index.ts` | Pass feed medium context through `EpisodeContext` so chapter extraction knows the feed type |

### Phase 2: Value Time Split Spec Compliance (4 changes)

| # | File | Change |
|---|------|--------|
| 2a | `lib/music-track-parser/extractors.ts:83` | Default `remotePercentage` to `100` instead of `0` |
| 2b | `lib/music-track-parser/extractors.ts:58` | Change `startTime > 0` to `startTime >= 0` |
| 2c | `lib/music-track-parser/extractors.ts` + `types.ts` | Parse and store `remoteStartTime` attribute |
| 2d | `lib/music-track-parser/extractors.ts:390` | Same `startTime >= 0` fix in `extractV4VTracksFromChapters` |

### Phase 3: Helipad Metadata & Payment Routing (2 changes)

| # | File | Change |
|---|------|--------|
| 3a | `components/Lightning/BoostButton.tsx` | Include `remoteStartTime` in Helipad metadata `ts` field when available |
| 3b | `lib/v4v-resolver.ts` | Strip nested `podcast:valueTimeSplit` when resolving remote value blocks |

### Phase 4: "Podcasts" Filter Tab on Main Page (3 changes)

| # | File | Change |
|---|------|--------|
| 4a | `components/ControlsBar.tsx` | Add `'podcasts'` to filter options array, render "Podcasts" button in both desktop and mobile layouts |
| 4b | `app/api/albums-fast/route.ts` | Add `case 'podcasts'` to filter switch — match feeds where `type = 'podcast'` with `podcast:medium` of `music` or `musicL`, or feeds explicitly tagged as music podcasts during import |
| 4c | `app/page.tsx` | Wire up `'podcasts'` filter to `handleFilterChange()` and URL params |

### Phase 5: Integration Test with Upbeats Feed (manual)

| # | Step |
|---|------|
| 5a | Import `https://feeds.rssblue.com/upbeats` via admin panel |
| 5b | Verify chapters are extracted as tracks (no false filtering) |
| 5c | Verify `toc: false` chapters are hidden |
| 5d | Verify chapter art loads (`img` field) |
| 5e | Verify VTS at position 0:00 is included |
| 5f | Verify `remotePercentage` defaults to 100 when omitted |
| 5g | Play through tracks — confirm BoostButton target switches per-track |
| 5h | Send test boost — confirm payment routes to the track's artist, not the show host |
| 5i | Verify "Podcasts" filter tab appears on main page and shows only music podcasts |

---

## Files Modified (9 files, 0 new)

1. `lib/music-track-parser/types.ts` — `ChapterData`, `EpisodeContext`, `ValueTimeSplit`
2. `lib/music-track-parser/index.ts` — chapter parsing, endTime chaining, toc filter, medium context
3. `lib/music-track-parser/utils.ts` — medium-aware chapter filtering
4. `lib/music-track-parser/extractors.ts` — remotePercentage default, startTime >= 0, remoteStartTime
5. `lib/v4v-resolver.ts` — nested VTS guard
6. `components/Lightning/BoostButton.tsx` — remoteStartTime in Helipad metadata
7. `components/ControlsBar.tsx` — "Podcasts" filter button
8. `app/api/albums-fast/route.ts` — podcasts filter case
9. `app/page.tsx` — podcasts filter state

## Risk Assessment

- **Low risk**: All changes are additive or fix defaults. Existing album/playlist flows are unaffected because:
  - Chapter filter bypass only activates for `medium: music/musicL` feeds
  - `remotePercentage` default change only matters when the attribute is absent (existing feeds that set it explicitly are unchanged)
  - `startTime >= 0` adds one previously-skipped track per episode at most
- **Build verification**: `npm run build` before commit per CLAUDE.md rules

## Deployment Steps (Podcast Chapter Navigation)

After merging `claude/add-podcast-feed-sUR9X` to main:

1. **Run database migration** — two new nullable columns on Track:
   ```sql
   ALTER TABLE "Track" ADD COLUMN "chaptersUrl" TEXT;
   ALTER TABLE "Track" ADD COLUMN "chapters" JSONB;
   ```
   Or via Prisma: `npx prisma migrate dev --name add_chapters_to_track`

2. **Reparse the UpBeats feed** to backfill chaptersUrl + chapters for existing episodes:
   ```
   curl -X POST https://stablekraft.app/api/admin/feeds/3aebb7a8-5942-5ee7-a148-8bdc14f1f3d4/reparse
   ```

3. **Verify** — play an UpBeats episode; skip forward should jump to the next chapter (not next episode). Chapter title appears below the artist in both the mini bar and fullscreen player.
