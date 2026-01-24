/**
 * Fix albums with empty track audioUrls by reparsing their feeds
 *
 * Usage: npx tsx scripts/fix-empty-tracks.ts [publisherId]
 * Example: npx tsx scripts/fix-empty-tracks.ts chris-nichols
 */

import { PrismaClient } from '@prisma/client';
import { parseRSSFeedWithSegments, calculateTrackOrder } from '../lib/rss-parser-db';

const prisma = new PrismaClient();

async function fixEmptyTracks() {
  const publisherId = process.argv[2];

  // Build query condition
  const whereCondition: any = {
    type: { in: ['album', 'music'] },
    status: 'active'
  };

  if (publisherId) {
    whereCondition.publisherId = publisherId;
    console.log(`🔍 Finding albums for publisher: ${publisherId}`);
  } else {
    console.log('🔍 Finding all albums with track issues...');
  }

  // Get all albums with their tracks
  const albums = await prisma.feed.findMany({
    where: whereCondition,
    select: {
      id: true,
      title: true,
      originalUrl: true,
      publisherId: true,
      Track: {
        select: {
          id: true,
          audioUrl: true
        }
      }
    }
  });

  console.log(`📋 Found ${albums.length} albums to check\n`);

  const problemAlbums: Array<{ id: string; title: string | null; url: string | null; totalTracks: number; emptyTracks: number }> = [];

  // Identify albums with issues
  for (const album of albums) {
    const validTracks = album.Track.filter(t => t.audioUrl && t.audioUrl.trim() !== '').length;
    const emptyTracks = album.Track.length - validTracks;

    // Flag albums with no valid tracks (or all empty)
    if (album.Track.length === 0 || validTracks === 0) {
      problemAlbums.push({
        id: album.id,
        title: album.title,
        url: album.originalUrl,
        totalTracks: album.Track.length,
        emptyTracks
      });
    }
  }

  console.log(`⚠️ Found ${problemAlbums.length} albums with track issues:\n`);
  problemAlbums.forEach(a => {
    console.log(`  - ${a.title || a.id}`);
    console.log(`    Tracks: ${a.totalTracks}, Empty audioUrl: ${a.emptyTracks}`);
    console.log(`    URL: ${a.url}`);
  });

  if (problemAlbums.length === 0) {
    console.log('✅ No albums need fixing!');
    await prisma.$disconnect();
    return;
  }

  console.log('\n🔧 Attempting to fix by reparsing feeds...\n');

  let fixed = 0;
  let failed = 0;

  for (const album of problemAlbums) {
    if (!album.url) {
      console.log(`❌ ${album.title || album.id}: No feed URL`);
      failed++;
      continue;
    }

    try {
      console.log(`🔄 Reparsing: ${album.title || album.id}`);

      // Parse the feed
      const parsedFeed = await parseRSSFeedWithSegments(album.url);

      if (!parsedFeed.items || parsedFeed.items.length === 0) {
        console.log(`  ⚠️ No items found in feed`);
        failed++;
        continue;
      }

      // Delete existing tracks with empty audioUrl (only empty string, not null)
      await prisma.track.deleteMany({
        where: {
          feedId: album.id,
          audioUrl: ''
        }
      });

      // Create new tracks from parsed feed
      const validItems = parsedFeed.items.filter(item => item.audioUrl && item.audioUrl.trim() !== '');
      console.log(`  📋 Found ${validItems.length} valid tracks in feed`);

      if (validItems.length > 0) {
        const tracksData = validItems.map((track, index) => ({
          id: `${album.id}-${track.guid || `track-${index}-${Date.now()}`}`,
          feedId: album.id,
          guid: track.guid,
          title: track.title,
          subtitle: track.subtitle,
          description: track.description,
          artist: track.artist,
          audioUrl: track.audioUrl,
          duration: track.duration,
          explicit: track.explicit,
          image: track.image,
          publishedAt: track.publishedAt,
          itunesAuthor: track.itunesAuthor,
          itunesSummary: track.itunesSummary,
          itunesImage: track.itunesImage,
          itunesDuration: track.itunesDuration,
          itunesKeywords: track.itunesKeywords || [],
          itunesCategories: track.itunesCategories || [],
          podcastCategories: parsedFeed.podcastCategories || [],
          v4vRecipient: track.v4vRecipient,
          v4vValue: track.v4vValue,
          startTime: track.startTime,
          endTime: track.endTime,
          trackOrder: track.episode ? calculateTrackOrder(track.episode, track.season) : index + 1,
          updatedAt: new Date()
        }));

        await prisma.track.createMany({
          data: tracksData,
          skipDuplicates: true
        });

        console.log(`  ✅ Created ${tracksData.length} tracks`);
        fixed++;
      } else {
        console.log(`  ⚠️ No valid tracks with audioUrl in feed`);
        failed++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`✅ Fixed: ${fixed}`);
  console.log(`❌ Failed: ${failed}`);

  await prisma.$disconnect();
}

fixEmptyTracks().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
