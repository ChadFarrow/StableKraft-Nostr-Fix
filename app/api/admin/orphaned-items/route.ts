import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET - Preview orphaned items (feeds/tracks not in any system playlist)
 */
export async function GET() {
  try {
    // Step 1: Find all feed IDs that have at least one track in a system playlist
    const feedsWithPlaylistTracks = await prisma.systemPlaylistTrack.findMany({
      select: {
        track: {
          select: {
            feedId: true
          }
        }
      }
    });

    const feedIdsToKeep = [...new Set(
      feedsWithPlaylistTracks
        .map(spt => spt.track?.feedId)
        .filter((id): id is string => !!id)
    )];

    console.log(`📋 Found ${feedIdsToKeep.length} feeds with tracks in playlists`);

    // Step 2: Count orphaned feeds
    const orphanedFeedCount = await prisma.feed.count({
      where: {
        id: { notIn: feedIdsToKeep }
      }
    });

    // Step 3: Count orphaned tracks (tracks whose feed is orphaned)
    const orphanedTrackCount = await prisma.track.count({
      where: {
        feedId: { notIn: feedIdsToKeep }
      }
    });

    // Step 4: Get sample of orphaned feeds for preview (limit 50)
    const orphanedFeeds = await prisma.feed.findMany({
      where: {
        id: { notIn: feedIdsToKeep }
      },
      select: {
        id: true,
        title: true,
        artist: true,
        image: true,
        type: true,
        createdAt: true,
        _count: { select: { Track: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    // Step 5: Get total counts for context
    const totalFeeds = await prisma.feed.count();
    const totalTracks = await prisma.track.count();

    return NextResponse.json({
      preview: true,
      feedsToKeep: feedIdsToKeep.length,
      orphanedFeeds: orphanedFeedCount,
      orphanedTracks: orphanedTrackCount,
      totalFeeds,
      totalTracks,
      sampleOrphanedFeeds: orphanedFeeds.map(f => ({
        id: f.id,
        title: f.title,
        artist: f.artist,
        image: f.image,
        type: f.type,
        trackCount: f._count.Track,
        createdAt: f.createdAt
      }))
    });

  } catch (error) {
    console.error('Error previewing orphaned items:', error);
    return NextResponse.json(
      { error: 'Failed to preview orphaned items', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove orphaned items (feeds/tracks not in any system playlist)
 */
export async function DELETE() {
  try {
    // Step 1: Find all feed IDs that have at least one track in a system playlist
    const feedsWithPlaylistTracks = await prisma.systemPlaylistTrack.findMany({
      select: {
        track: {
          select: {
            feedId: true
          }
        }
      }
    });

    const feedIdsToKeep = [...new Set(
      feedsWithPlaylistTracks
        .map(spt => spt.track?.feedId)
        .filter((id): id is string => !!id)
    )];

    console.log(`🔒 Keeping ${feedIdsToKeep.length} feeds with tracks in playlists`);

    // Step 2: Get counts before deletion
    const orphanedFeedCount = await prisma.feed.count({
      where: { id: { notIn: feedIdsToKeep } }
    });

    const orphanedTrackCount = await prisma.track.count({
      where: { feedId: { notIn: feedIdsToKeep } }
    });

    if (orphanedFeedCount === 0) {
      return NextResponse.json({
        success: true,
        message: 'No orphaned items to delete',
        deletedFeeds: 0,
        deletedTracks: 0
      });
    }

    console.log(`🗑️ Deleting ${orphanedFeedCount} orphaned feeds and ${orphanedTrackCount} orphaned tracks...`);

    // Step 3: Delete orphaned feeds (tracks cascade automatically due to schema)
    const deleteResult = await prisma.feed.deleteMany({
      where: { id: { notIn: feedIdsToKeep } }
    });

    console.log(`✅ Deleted ${deleteResult.count} feeds`);

    return NextResponse.json({
      success: true,
      deletedFeeds: deleteResult.count,
      deletedTracks: orphanedTrackCount,
      remainingFeeds: feedIdsToKeep.length
    });

  } catch (error) {
    console.error('Error deleting orphaned items:', error);
    return NextResponse.json(
      { error: 'Failed to delete orphaned items', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
