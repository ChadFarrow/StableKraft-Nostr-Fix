/**
 * Relink Publishers Migration Script
 *
 * This script re-links albums to their publisher feeds by:
 * 1. Fetching each publisher's XML feed
 * 2. Extracting remoteItem GUIDs that reference albums
 * 3. Finding albums by feedGuid/feedUrl match
 * 4. Finding albums by artist name match (case-insensitive)
 * 5. Updating publisherId on all matched albums
 *
 * Run with: npx tsx scripts/relink-publishers.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Extract remoteItem tags from publisher feed XML
 */
function extractRemoteItemsFromXML(xml: string): Array<{ feedGuid: string; feedUrl: string }> {
  const items: Array<{ feedGuid: string; feedUrl: string }> = [];

  const remoteItemRegex = /<podcast:remoteItem[^>]*>/gi;
  const matches = xml.match(remoteItemRegex) || [];

  for (const match of matches) {
    const feedGuidMatch = match.match(/feedGuid=["']([^"']+)["']/i);
    const feedUrlMatch = match.match(/feedUrl=["']([^"']+)["']/i);
    const mediumMatch = match.match(/medium=["']([^"']+)["']/i);

    // Only include music/album references, not publisher references
    const medium = mediumMatch?.[1] || '';
    if (medium === 'publisher') continue;

    if (feedGuidMatch || feedUrlMatch) {
      items.push({
        feedGuid: feedGuidMatch?.[1] || '',
        feedUrl: feedUrlMatch?.[1] || ''
      });
    }
  }

  return items;
}

/**
 * Link albums to publisher by updating publisherId field
 */
async function linkAlbumsToPublisher(
  publisherId: string,
  remoteItems: Array<{ feedGuid: string; feedUrl: string }>,
  artistName?: string | null
): Promise<{ linkedByGuid: number; linkedByArtist: number }> {
  let linkedByGuid = 0;
  let linkedByArtist = 0;

  // Link by remote item GUIDs/URLs
  for (const item of remoteItems) {
    const conditions: any[] = [];
    if (item.feedGuid) {
      conditions.push({ id: item.feedGuid });
      conditions.push({ guid: item.feedGuid });
      // Also try matching GUID in originalUrl
      conditions.push({ originalUrl: { contains: item.feedGuid } });
    }
    if (item.feedUrl) {
      conditions.push({ originalUrl: item.feedUrl });
    }

    if (conditions.length === 0) continue;

    const result = await prisma.feed.updateMany({
      where: {
        OR: conditions,
        type: { in: ['album', 'music'] },
        publisherId: null
      },
      data: { publisherId }
    });

    linkedByGuid += result.count;
  }

  // Link by artist name match (exact, case-insensitive)
  if (artistName) {
    const result = await prisma.feed.updateMany({
      where: {
        artist: { equals: artistName, mode: 'insensitive' },
        type: { in: ['album', 'music'] },
        publisherId: null
      },
      data: { publisherId }
    });

    linkedByArtist = result.count;
  }

  return { linkedByGuid, linkedByArtist };
}

async function main() {
  console.log('🚀 Starting Publisher Re-Link Migration...\n');

  // Get all publisher feeds
  const publishers = await prisma.feed.findMany({
    where: {
      type: 'publisher',
      status: 'active'
    },
    select: {
      id: true,
      title: true,
      artist: true,
      originalUrl: true
    },
    orderBy: { title: 'asc' }
  });

  console.log(`📊 Found ${publishers.length} publisher feeds to process\n`);

  let totalProcessed = 0;
  let totalLinkedByGuid = 0;
  let totalLinkedByArtist = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const publisher of publishers) {
    console.log(`\n📋 Processing: ${publisher.title || publisher.id}`);

    // Get current album count for this publisher
    const currentCount = await prisma.feed.count({
      where: { publisherId: publisher.id }
    });
    console.log(`   Current linked albums: ${currentCount}`);

    if (!publisher.originalUrl) {
      console.log(`   ⚠️  No feed URL, skipping XML fetch`);

      // Still try artist name matching
      const artistName = publisher.artist || publisher.title;
      if (artistName) {
        const result = await linkAlbumsToPublisher(publisher.id, [], artistName);
        if (result.linkedByArtist > 0) {
          totalLinkedByArtist += result.linkedByArtist;
          console.log(`   ✅ Linked ${result.linkedByArtist} albums by artist name`);
        }
      }

      totalSkipped++;
      continue;
    }

    try {
      // Fetch publisher feed XML
      console.log(`   📡 Fetching: ${publisher.originalUrl}`);
      const response = await fetch(publisher.originalUrl, {
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        console.log(`   ❌ Failed to fetch: ${response.status}`);
        totalFailed++;

        // Still try artist name matching
        const artistName = publisher.artist || publisher.title;
        if (artistName) {
          const result = await linkAlbumsToPublisher(publisher.id, [], artistName);
          if (result.linkedByArtist > 0) {
            totalLinkedByArtist += result.linkedByArtist;
            console.log(`   ✅ Linked ${result.linkedByArtist} albums by artist name (fallback)`);
          }
        }
        continue;
      }

      const xmlText = await response.text();
      const remoteItems = extractRemoteItemsFromXML(xmlText);
      console.log(`   📋 Found ${remoteItems.length} remote items in feed`);

      // Get artist name for fallback matching
      const artistName = publisher.artist || publisher.title;

      // Link albums
      const result = await linkAlbumsToPublisher(publisher.id, remoteItems, artistName);

      totalLinkedByGuid += result.linkedByGuid;
      totalLinkedByArtist += result.linkedByArtist;
      totalProcessed++;

      if (result.linkedByGuid > 0 || result.linkedByArtist > 0) {
        console.log(`   ✅ Linked ${result.linkedByGuid} by GUID, ${result.linkedByArtist} by artist`);
      } else {
        console.log(`   ℹ️  No new albums to link`);
      }

      // Get updated count
      const newCount = await prisma.feed.count({
        where: { publisherId: publisher.id }
      });
      console.log(`   📊 Total linked albums now: ${newCount}`);

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.log(`   ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      totalFailed++;

      // Still try artist name matching
      const artistName = publisher.artist || publisher.title;
      if (artistName) {
        const result = await linkAlbumsToPublisher(publisher.id, [], artistName);
        if (result.linkedByArtist > 0) {
          totalLinkedByArtist += result.linkedByArtist;
          console.log(`   ✅ Linked ${result.linkedByArtist} albums by artist name (fallback)`);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Migration Complete!');
  console.log('='.repeat(60));
  console.log(`Total publishers processed: ${totalProcessed}`);
  console.log(`Total publishers skipped (no URL): ${totalSkipped}`);
  console.log(`Total publishers failed: ${totalFailed}`);
  console.log(`Albums linked by GUID: ${totalLinkedByGuid}`);
  console.log(`Albums linked by artist name: ${totalLinkedByArtist}`);
  console.log(`Total albums newly linked: ${totalLinkedByGuid + totalLinkedByArtist}`);

  // Final summary: show album counts per publisher
  console.log('\n📋 Publisher Album Counts:');
  console.log('-'.repeat(60));

  const publisherCounts = await prisma.feed.groupBy({
    by: ['publisherId'],
    where: {
      publisherId: { not: null }
    },
    _count: { id: true }
  });

  for (const pc of publisherCounts) {
    if (!pc.publisherId) continue;
    const pub = publishers.find(p => p.id === pc.publisherId);
    console.log(`  ${pub?.title || pc.publisherId}: ${pc._count.id} albums`);
  }

  // Also show unlinked albums count
  const unlinkedCount = await prisma.feed.count({
    where: {
      type: { in: ['album', 'music'] },
      publisherId: null
    }
  });
  console.log(`\n  📌 Unlinked albums: ${unlinkedCount}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('Fatal error:', error);
  await prisma.$disconnect();
  process.exit(1);
});
