/**
 * Import missing albums from a publisher's feed
 *
 * Usage: npx tsx scripts/import-publisher-albums.ts <publisher-feed-url>
 * Example: npx tsx scripts/import-publisher-albums.ts https://wavlake.com/feed/artist/5df06712-ca58-49c8-b19a-28ddd2d242ff
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface RemoteItem {
  feedGuid: string;
  feedUrl: string;
}

function extractRemoteItems(xml: string): RemoteItem[] {
  const items: RemoteItem[] = [];
  const regex = /<podcast:remoteItem[^>]*>/gi;
  const matches = xml.match(regex) || [];

  for (const match of matches) {
    const feedGuidMatch = match.match(/feedGuid="([^"]+)"/i);
    const feedUrlMatch = match.match(/feedUrl="([^"]+)"/i);
    const mediumMatch = match.match(/medium="([^"]+)"/i);

    // Skip publisher references
    if (mediumMatch?.[1] === 'publisher') continue;

    if (feedUrlMatch?.[1]) {
      items.push({
        feedGuid: feedGuidMatch?.[1] || '',
        feedUrl: feedUrlMatch[1]
      });
    }
  }

  return items;
}

async function importAlbumFeed(feedUrl: string, publisherId: string): Promise<{ success: boolean; title?: string; error?: string }> {
  try {
    // Check if already exists by URL
    const existing = await prisma.feed.findFirst({
      where: {
        originalUrl: feedUrl
      }
    });

    if (existing) {
      // Update publisherId if not set
      if (!existing.publisherId) {
        await prisma.feed.update({
          where: { id: existing.id },
          data: { publisherId }
        });
        return { success: true, title: existing.title || existing.id + ' (linked)' };
      }
      return { success: true, title: existing.title || existing.id + ' (exists)' };
    }

    // Fetch and parse the feed
    const response = await fetch(feedUrl, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const xml = await response.text();

    // Extract basic metadata
    const titleMatch = xml.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)/i);
    const descMatch = xml.match(/<description>(?:<!\[CDATA\[)?([^\]<]+)/i);
    const imageMatch = xml.match(/<itunes:image[^>]*href="([^"]+)"/i) || xml.match(/<image>[\s\S]*?<url>([^<]+)/i);
    const authorMatch = xml.match(/<itunes:author>(?:<!\[CDATA\[)?([^\]<]+)/i);
    const guidMatch = xml.match(/<podcast:guid>([^<]+)/i);

    const title = titleMatch?.[1]?.trim() || 'Unknown Album';
    const description = descMatch?.[1]?.trim() || '';
    const image = imageMatch?.[1]?.trim() || null;
    const artist = authorMatch?.[1]?.trim() || null;
    const podcastGuid = guidMatch?.[1]?.trim() || null;

    // Generate feed ID
    const slugTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slugArtist = artist ? artist.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
    let feedId = slugArtist ? `${slugArtist}-${slugTitle}` : slugTitle;

    // Check for ID collision
    const idExists = await prisma.feed.findUnique({ where: { id: feedId } });
    if (idExists) {
      feedId = `${feedId}-${Date.now()}`;
    }

    // Check for GUID collision if we have one
    if (podcastGuid) {
      const guidExists = await prisma.feed.findFirst({ where: { guid: podcastGuid } });
      if (guidExists) {
        // Link existing feed to publisher
        if (!guidExists.publisherId) {
          await prisma.feed.update({
            where: { id: guidExists.id },
            data: { publisherId }
          });
        }
        return { success: true, title: guidExists.title || guidExists.id + ' (by GUID)' };
      }
    }

    // Extract tracks/items
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    const items = xml.match(itemRegex) || [];

    // Create the feed
    const feed = await prisma.feed.create({
      data: {
        id: feedId,
        guid: podcastGuid,
        originalUrl: feedUrl,
        cdnUrl: feedUrl,
        type: 'album',
        priority: 'normal',
        status: 'active',
        title,
        description,
        artist,
        image,
        publisherId,
        lastFetched: new Date(),
        updatedAt: new Date()
      }
    });

    // Create tracks
    let trackOrder = 1;
    for (const itemXml of items) {
      const trackTitleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)/i);
      const enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]+)"/i);
      const trackGuidMatch = itemXml.match(/<guid[^>]*>([^<]+)/i);
      const durationMatch = itemXml.match(/<itunes:duration>([^<]+)/i);

      const trackTitle = trackTitleMatch?.[1]?.trim() || 'Unknown Track';
      const audioUrl = enclosureMatch?.[1]?.trim() || '';
      const trackGuid = trackGuidMatch?.[1]?.trim() || `${feed.id}-track-${trackOrder}`;

      if (!audioUrl) continue;

      // Parse duration
      let duration: number | null = null;
      if (durationMatch?.[1]) {
        const parts = durationMatch[1].split(':');
        if (parts.length === 3) {
          duration = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
        } else if (parts.length === 2) {
          duration = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        } else {
          duration = parseInt(parts[0]);
        }
      }

      try {
        await prisma.track.create({
          data: {
            id: `${feed.id}-${trackGuid}`,
            guid: trackGuid,
            feedId: feed.id,
            title: trackTitle,
            audioUrl,
            duration,
            trackOrder,
            updatedAt: new Date()
          }
        });
        trackOrder++;
      } catch (e) {
        // Track might already exist, skip
      }
    }

    return { success: true, title: `${title} (${trackOrder - 1} tracks)` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function main() {
  const publisherUrl = process.argv[2];

  if (!publisherUrl) {
    console.log('Usage: npx tsx scripts/import-publisher-albums.ts <publisher-feed-url>');
    console.log('Example: npx tsx scripts/import-publisher-albums.ts https://wavlake.com/feed/artist/5df06712-ca58-49c8-b19a-28ddd2d242ff');
    process.exit(1);
  }

  console.log(`🚀 Importing albums from publisher feed: ${publisherUrl}\n`);

  // Fetch publisher feed
  const response = await fetch(publisherUrl, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    console.error(`Failed to fetch publisher feed: HTTP ${response.status}`);
    process.exit(1);
  }

  const xml = await response.text();

  // Extract publisher info
  const titleMatch = xml.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)/i);
  const publisherTitle = titleMatch?.[1]?.trim() || 'Unknown Publisher';
  console.log(`Publisher: ${publisherTitle}`);

  // Find or create publisher feed in database
  let publisherFeed = await prisma.feed.findFirst({
    where: { originalUrl: publisherUrl }
  });

  if (!publisherFeed) {
    const slugTitle = publisherTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    publisherFeed = await prisma.feed.create({
      data: {
        id: slugTitle,
        originalUrl: publisherUrl,
        cdnUrl: publisherUrl,
        type: 'publisher',
        status: 'active',
        title: publisherTitle,
        lastFetched: new Date(),
        updatedAt: new Date()
      }
    });
    console.log(`Created publisher feed: ${publisherFeed.id}`);
  } else {
    console.log(`Publisher feed exists: ${publisherFeed.id}`);
  }

  // Extract remote items
  const remoteItems = extractRemoteItems(xml);
  console.log(`\nFound ${remoteItems.length} album references\n`);

  // Import each album
  let imported = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of remoteItems) {
    if (!item.feedUrl) {
      skipped++;
      continue;
    }

    process.stdout.write(`Importing ${item.feedUrl.split('/').pop()}... `);
    const result = await importAlbumFeed(item.feedUrl, publisherFeed.id);

    if (result.success) {
      console.log(`✅ ${result.title}`);
      imported++;
    } else {
      console.log(`❌ ${result.error}`);
      failed++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Imported: ${imported}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);

  // Verify final count
  const linkedCount = await prisma.feed.count({
    where: { publisherId: publisherFeed.id }
  });
  console.log(`\nTotal albums linked to ${publisherTitle}: ${linkedCount}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
