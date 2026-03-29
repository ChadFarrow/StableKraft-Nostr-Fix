import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PODCAST_FEED_IDS, PODCAST_FEED_URLS } from '@/lib/podcast-feeds';

/**
 * POST /api/admin/fix-podcast-types
 * One-time fix: reset Wavlake/source feeds with type='podcast' back to 'album',
 * except for curated podcast feeds that should remain type='podcast'.
 */
export async function POST() {
  try {
    // Find all feeds with type='podcast' that are NOT curated podcasts
    const mistyped = await prisma.feed.findMany({
      where: {
        type: 'podcast',
        id: { notIn: PODCAST_FEED_IDS },
        originalUrl: { notIn: PODCAST_FEED_URLS },
      },
      select: { id: true, title: true, originalUrl: true }
    });

    if (mistyped.length === 0) {
      return NextResponse.json({ success: true, message: 'No mistyped feeds found', fixed: 0 });
    }

    // Update them all to type='album'
    const result = await prisma.feed.updateMany({
      where: {
        id: { in: mistyped.map(f => f.id) }
      },
      data: { type: 'album' }
    });

    return NextResponse.json({
      success: true,
      fixed: result.count,
      feeds: mistyped.map(f => ({ id: f.id, title: f.title }))
    });
  } catch (error) {
    console.error('Error fixing podcast types:', error);
    return NextResponse.json({ success: false, error: 'Failed to fix podcast types' }, { status: 500 });
  }
}
