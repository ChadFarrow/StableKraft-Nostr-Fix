import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseRSSFeedWithSegments, applyParsedItemFields } from '@/lib/rss-parser-db';

/**
 * POST /api/admin/fix-stale-vts
 * Find tracks with VTS data that have empty remoteItem GUIDs and reparse their feeds.
 * This fixes stale VTS data from before the XML entity title-matching fix.
 */
export async function POST() {
  const startTime = Date.now();

  try {
    // Find tracks with VTS data containing empty remoteItem GUIDs
    const staleTracksRaw: Array<{ feedId: string }> = await prisma.$queryRaw`
      SELECT DISTINCT "feedId"
      FROM "Track"
      WHERE "valueTimeSplits" IS NOT NULL
        AND jsonb_typeof("valueTimeSplits") = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements("valueTimeSplits") elem
          WHERE elem->'remoteItem' IS NOT NULL
            AND (elem->'remoteItem'->>'feedGuid' = '' OR elem->'remoteItem'->>'itemGuid' = '')
        )
    `;

    const feedIds = staleTracksRaw.map(t => t.feedId);

    if (feedIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No feeds with stale VTS data found',
        feedsFixed: 0,
        tracksUpdated: 0,
        duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
    }

    // Get feed details
    const feeds = await prisma.feed.findMany({
      where: { id: { in: feedIds } },
      select: { id: true, title: true, originalUrl: true }
    });

    console.log(`🔧 Found ${feeds.length} feeds with stale VTS data: ${feeds.map(f => f.title).join(', ')}`);

    let feedsFixed = 0;
    let totalTracksUpdated = 0;
    const errors: string[] = [];

    for (const feed of feeds) {
      try {
        // Reparse the feed
        const parsedFeed = await parseRSSFeedWithSegments(feed.originalUrl);

        // Get existing tracks for this feed
        const existingTracks = await prisma.track.findMany({
          where: { feedId: feed.id },
          select: { id: true, guid: true, title: true, audioUrl: true }
        });

        const parsedItemsByGuid = new Map(
          parsedFeed.items.map(item => [item.guid, item])
        );

        let tracksUpdated = 0;

        for (const track of existingTracks) {
          let matchedItem = track.guid ? parsedItemsByGuid.get(track.guid) || null : null;

          if (!matchedItem && track.title && track.audioUrl) {
            matchedItem = parsedFeed.items.find(item =>
              item.audioUrl === track.audioUrl || item.title === track.title
            ) || null;
          }

          if (matchedItem?.valueTimeSplits && matchedItem.valueTimeSplits.length > 0) {
            const hasGUIDs = matchedItem.valueTimeSplits.some(
              vts => vts.remoteItem?.feedGuid && vts.remoteItem?.itemGuid
            );

            if (hasGUIDs) {
              await prisma.track.update({
                where: { id: track.id },
                data: { valueTimeSplits: matchedItem.valueTimeSplits }
              });
              tracksUpdated++;
            }
          }
        }

        // Update feed lastFetched
        await prisma.feed.update({
          where: { id: feed.id },
          data: { lastFetched: new Date() }
        });

        console.log(`✅ Fixed ${tracksUpdated} tracks in "${feed.title}"`);
        totalTracksUpdated += tracksUpdated;
        feedsFixed++;
      } catch (feedError) {
        const msg = `Failed to fix feed "${feed.title}": ${feedError instanceof Error ? feedError.message : 'Unknown error'}`;
        console.error(`❌ ${msg}`);
        errors.push(msg);
      }
    }

    return NextResponse.json({
      success: true,
      feedsFixed,
      tracksUpdated: totalTracksUpdated,
      errors: errors.length > 0 ? errors : undefined,
      duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
    });
  } catch (error) {
    console.error('Error fixing stale VTS data:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
