import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseRSSFeedWithSegments, calculateTrackOrder } from '@/lib/rss-parser-db';

/**
 * POST /api/admin/feeds/fix-tracks
 * Find albums with missing/empty track audioUrls and reparse them
 * Body: { publisherId?: string, dryRun?: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { publisherId, dryRun = false } = body;

    // Build query condition
    const whereCondition: any = {
      type: { in: ['album', 'music'] },
      status: 'active'
    };

    if (publisherId) {
      whereCondition.publisherId = publisherId;
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

    // Identify albums with issues (no tracks or all empty audioUrl)
    const problemAlbums = albums.filter(album => {
      const validTracks = album.Track.filter(t => t.audioUrl && t.audioUrl.trim() !== '').length;
      return album.Track.length === 0 || validTracks === 0;
    });

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        message: `Found ${problemAlbums.length} albums with track issues`,
        albums: problemAlbums.map(a => ({
          id: a.id,
          title: a.title,
          totalTracks: a.Track.length,
          url: a.originalUrl
        }))
      });
    }

    if (problemAlbums.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No albums need fixing',
        fixed: 0,
        failed: 0
      });
    }

    console.log(`🔧 Fixing ${problemAlbums.length} albums with track issues`);

    let fixed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const album of problemAlbums) {
      if (!album.originalUrl) {
        errors.push(`${album.id}: No feed URL`);
        failed++;
        continue;
      }

      try {
        // Parse the feed
        const parsedFeed = await parseRSSFeedWithSegments(album.originalUrl);

        if (!parsedFeed.items || parsedFeed.items.length === 0) {
          errors.push(`${album.id}: No items in feed`);
          failed++;
          continue;
        }

        // Delete existing tracks with empty audioUrl
        await prisma.track.deleteMany({
          where: {
            feedId: album.id,
            OR: [
              { audioUrl: '' },
              { audioUrl: { equals: null as unknown as string } }
            ]
          }
        });

        // Create new tracks from parsed feed
        const validItems = parsedFeed.items.filter(item => item.audioUrl && item.audioUrl.trim() !== '');

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

          console.log(`✅ ${album.title}: ${tracksData.length} tracks`);
          fixed++;
        } else {
          errors.push(`${album.id}: No valid tracks in feed`);
          failed++;
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 100));
      } catch (error) {
        errors.push(`${album.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        failed++;
      }
    }

    return NextResponse.json({
      success: true,
      message: `Fixed ${fixed} of ${problemAlbums.length} albums`,
      fixed,
      failed,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Error fixing tracks:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

/**
 * GET /api/admin/feeds/fix-tracks?publisherId=xxx
 * Check for albums with track issues (dry run)
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const publisherId = searchParams.get('publisherId');

  // Build query condition
  const whereCondition: any = {
    type: { in: ['album', 'music'] },
    status: 'active'
  };

  if (publisherId) {
    whereCondition.publisherId = publisherId;
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

  // Identify albums with issues
  const problemAlbums = albums.filter(album => {
    const validTracks = album.Track.filter(t => t.audioUrl && t.audioUrl.trim() !== '').length;
    return album.Track.length === 0 || validTracks === 0;
  });

  return NextResponse.json({
    total: albums.length,
    problemCount: problemAlbums.length,
    problems: problemAlbums.map(a => ({
      id: a.id,
      title: a.title,
      publisherId: a.publisherId,
      totalTracks: a.Track.length,
      emptyTracks: a.Track.filter(t => !t.audioUrl || t.audioUrl.trim() === '').length,
      url: a.originalUrl
    }))
  });
}
