import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseRSSFeedWithSegments } from '@/lib/rss-parser-db';
import { discoverAndStorePublisher, extractPublisherFromXML } from '@/lib/publisher-discovery';

// POST /api/feeds/[id]/refresh - Refresh a specific feed (Railway fix)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    // Get the feed
    const feed = await prisma.feed.findUnique({
      where: { id }
    });
    
    if (!feed) {
      return NextResponse.json(
        { error: 'Feed not found' },
        { status: 404 }
      );
    }
    
    try {
      // Parse the RSS feed
      const parsedFeed = await parseRSSFeedWithSegments(feed.originalUrl);
      
      // Update feed metadata
      await prisma.feed.update({
        where: { id },
        data: {
          title: parsedFeed.title,
          description: parsedFeed.description,
          artist: parsedFeed.artist,
          image: parsedFeed.image,
          language: parsedFeed.language,
          category: parsedFeed.category,
          explicit: parsedFeed.explicit,
          lastFetched: new Date(),
          status: 'active',
          lastError: null
        }
      });

      // Discover publisher from album feed (if this is an album/music feed)
      if (feed.type === 'album' || feed.type === 'music') {
        try {
          const feedResponse = await fetch(feed.originalUrl, {
            signal: AbortSignal.timeout(10000)
          });
          if (feedResponse.ok) {
            const xml = await feedResponse.text();
            const publisherRef = extractPublisherFromXML(xml);
            if (publisherRef) {
              await discoverAndStorePublisher(publisherRef);
            }
          }
        } catch (pubError) {
          console.warn('Could not discover publisher:', pubError);
        }
      }

      // Get existing track GUIDs to avoid duplicates
      const existingTracks = await prisma.track.findMany({
        where: { feedId: id },
        select: { guid: true, id: true }
      });

      const existingGuids = new Set(existingTracks.map(t => t.guid).filter(Boolean));
      const guidToId = new Map(existingTracks.filter(t => t.guid).map(t => [t.guid, t.id]));

      // Filter out tracks that already exist
      const newItems = parsedFeed.items.filter(item =>
        !item.guid || !existingGuids.has(item.guid)
      );

      // Update existing tracks with video metadata (mediaType, alternateEnclosures)
      const existingItems = parsedFeed.items.filter(item =>
        item.guid && existingGuids.has(item.guid)
      );

      let updatedCount = 0;
      for (const item of existingItems) {
        if (item.guid && (item.alternateEnclosures?.length || item.mediaType === 'video')) {
          const trackId = guidToId.get(item.guid);
          if (trackId) {
            await prisma.track.update({
              where: { id: trackId },
              data: {
                mediaType: item.mediaType || 'audio',
                mimeType: item.mimeType,
                alternateEnclosures: item.alternateEnclosures ? JSON.parse(JSON.stringify(item.alternateEnclosures)) : undefined,
                updatedAt: new Date()
              }
            });
            updatedCount++;
          }
        }
      }

      if (updatedCount > 0) {
        console.log(`✅ Updated ${updatedCount} existing tracks with video metadata`);
      }

      // Add new tracks
      if (newItems.length > 0) {
        const tracksData = newItems.map((item, index) => ({
          id: `${id}-${item.guid || `track-${index}-${Date.now()}`}`,
          feedId: id,
          guid: item.guid,
          title: item.title,
          subtitle: item.subtitle,
          description: item.description,
          artist: item.artist,
          audioUrl: item.audioUrl,
          mediaType: item.mediaType || 'audio',
          mimeType: item.mimeType,
          alternateEnclosures: item.alternateEnclosures ? JSON.parse(JSON.stringify(item.alternateEnclosures)) : undefined,
          duration: item.duration,
          explicit: item.explicit,
          image: item.image,
          publishedAt: item.publishedAt,
          itunesAuthor: item.itunesAuthor,
          itunesSummary: item.itunesSummary,
          itunesImage: item.itunesImage,
          itunesDuration: item.itunesDuration,
          itunesKeywords: item.itunesKeywords || [],
          itunesCategories: item.itunesCategories || [],
          podcastCategories: parsedFeed.podcastCategories || [],
          v4vRecipient: item.v4vRecipient,
          v4vValue: item.v4vValue,
          startTime: item.startTime,
          endTime: item.endTime,
          updatedAt: new Date()
        }));

        await prisma.track.createMany({
          data: tracksData,
          skipDuplicates: true
        });
      }
      
      // Get updated feed with counts
      const updatedFeed = await prisma.feed.findUnique({
        where: { id },
        include: {
          _count: {
            select: { Track: true }
          }
        }
      });
      
      return NextResponse.json({
        message: 'Feed refreshed successfully',
        feed: updatedFeed,
        newTracks: newItems.length,
        updatedTracks: updatedCount
      });
      
    } catch (parseError) {
      // Update feed with error status
      const errorMessage = parseError instanceof Error ? parseError.message : 'Unknown error';
      
      await prisma.feed.update({
        where: { id },
        data: {
          status: 'error',
          lastError: errorMessage,
          lastFetched: new Date()
        }
      });
      
      return NextResponse.json({
        error: 'Failed to refresh feed',
        message: errorMessage
      }, { status: 500 });
    }
  } catch (error) {
    console.error('Error refreshing feed:', error);
    return NextResponse.json(
      { error: 'Failed to refresh feed' },
      { status: 500 }
    );
  }
}