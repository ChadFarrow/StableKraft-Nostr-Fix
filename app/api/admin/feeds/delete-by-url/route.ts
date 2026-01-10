import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateAlbumSlug } from '@/lib/url-utils';

/**
 * Extract album slug from various URL formats:
 * - http://localhost:3000/album/aseda -> aseda
 * - https://stablekraft.app/album/some-album -> some-album
 * - /album/my-album -> my-album
 */
function extractSlugFromUrl(url: string): string | null {
  try {
    // Handle relative paths
    if (url.startsWith('/album/')) {
      return url.replace('/album/', '').split('?')[0];
    }

    // Handle full URLs
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const albumIndex = pathParts.indexOf('album');

    if (albumIndex !== -1 && pathParts[albumIndex + 1]) {
      return decodeURIComponent(pathParts[albumIndex + 1]);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Find a feed by slug using multi-tier matching (same logic as /api/albums/[slug])
 */
async function findFeedBySlug(slug: string) {
  // 1. Exact ID match (fastest)
  let feed = await prisma.feed.findFirst({
    where: {
      status: 'active',
      id: { equals: slug, mode: 'insensitive' }
    },
    select: {
      id: true,
      title: true,
      artist: true,
      image: true,
      _count: { select: { Track: true } }
    }
  });

  if (feed) return feed;

  // 2. Generated slug match - find feeds whose title generates this slug
  const titleSearch = slug.replace(/-/g, ' ');
  const titleSearchWithAmpersand = titleSearch.replace(/\band\b/g, '&');

  const candidateFeeds = await prisma.feed.findMany({
    where: {
      status: 'active',
      OR: [
        { title: { contains: titleSearch, mode: 'insensitive' } },
        { title: { contains: titleSearchWithAmpersand, mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      title: true,
      artist: true,
      image: true,
      _count: { select: { Track: true } }
    },
    take: 50
  });

  for (const candidate of candidateFeeds) {
    const albumSlug = generateAlbumSlug(candidate.title);
    if (albumSlug === slug) {
      return candidate;
    }
  }

  // 3. ID contains match (handle variations like "thats" vs "that-s")
  const slugVariations = [
    slug,
    slug.replace(/thats/g, 'that-s'),
    slug.replace(/dont/g, "don-t"),
    slug.replace(/cant/g, "can-t")
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  const orConditions: any[] = [];
  for (const variation of slugVariations) {
    orConditions.push({ id: { contains: variation, mode: 'insensitive' } });
    orConditions.push({ id: { endsWith: `-${variation}`, mode: 'insensitive' } });
  }

  feed = await prisma.feed.findFirst({
    where: {
      status: 'active',
      OR: orConditions
    },
    select: {
      id: true,
      title: true,
      artist: true,
      image: true,
      _count: { select: { Track: true } }
    }
  });

  if (feed) return feed;

  // 4. Title-based fallback
  feed = await prisma.feed.findFirst({
    where: {
      status: 'active',
      title: { contains: titleSearch, mode: 'insensitive' }
    },
    select: {
      id: true,
      title: true,
      artist: true,
      image: true,
      _count: { select: { Track: true } }
    }
  });

  return feed;
}

// POST /api/admin/feeds/delete-by-url
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, preview = false } = body;

    if (!url) {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    // Extract slug from URL
    const slug = extractSlugFromUrl(url);

    if (!slug) {
      return NextResponse.json(
        { error: 'Could not extract album slug from URL. Expected format: /album/slug-name' },
        { status: 400 }
      );
    }

    console.log(`🔍 Looking up feed for slug: "${slug}"`);

    // Find the feed
    const feed = await findFeedBySlug(slug);

    if (!feed) {
      return NextResponse.json({
        found: false,
        slug,
        message: `No feed found matching slug "${slug}"`
      });
    }

    // Preview mode - just return feed info
    if (preview) {
      return NextResponse.json({
        found: true,
        feed: {
          id: feed.id,
          title: feed.title,
          artist: feed.artist,
          image: feed.image,
          trackCount: feed._count.Track
        }
      });
    }

    // Delete mode - delete the feed (tracks cascade)
    console.log(`🗑️ Deleting feed: "${feed.title}" by ${feed.artist} (ID: ${feed.id})`);

    await prisma.feed.delete({
      where: { id: feed.id }
    });

    return NextResponse.json({
      success: true,
      deleted: {
        id: feed.id,
        title: feed.title,
        artist: feed.artist,
        trackCount: feed._count.Track
      }
    });

  } catch (error) {
    console.error('Error in delete-by-url:', error);
    return NextResponse.json(
      { error: 'Failed to process request', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
