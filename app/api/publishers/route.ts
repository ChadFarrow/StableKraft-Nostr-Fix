import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateAlbumSlug } from '@/lib/url-utils';

export async function GET() {
  try {
    console.log('🔍 Publishers API: Loading publishers from database');

    // Get all album feeds with track counts and images, grouped by artist
    const albumFeeds = await prisma.feed.findMany({
      where: {
        type: { in: ['album', 'music'] },
        status: 'active'
      },
      select: {
        id: true,
        title: true,
        artist: true,
        image: true,
        updatedAt: true,
        _count: {
          select: { Track: true }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    console.log(`📊 Found ${albumFeeds.length} album feeds`);

    // Group albums by artist name to create publishers
    const artistAlbums = new Map<string, typeof albumFeeds>();
    for (const album of albumFeeds) {
      if (!album.artist || album._count.Track === 0) continue;

      const artistKey = album.artist.toLowerCase().trim();
      const existing = artistAlbums.get(artistKey) || [];
      existing.push(album);
      artistAlbums.set(artistKey, existing);
    }

    // Transform to the expected format
    const publisherList: {
      id: string;
      title: string;
      feedGuid: string;
      originalUrl: string | null;
      image: string;
      description: string;
      albums: never[];
      itemCount: number;
      totalTracks: number;
      isPublisherCard: boolean;
      publisherUrl: string;
    }[] = [];

    for (const [artistKey, albums] of artistAlbums) {
      // Only include artists with more than 1 release
      if (albums.length <= 1) continue;

      const artistName = albums[0].artist || 'Unknown Artist';
      const trackCount = albums.reduce((sum, album) => sum + album._count.Track, 0);

      // Use the most recent album's image as the publisher image
      const sortedAlbums = albums.sort((a, b) =>
        new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
      );
      const image = sortedAlbums.find(a => a.image)?.image || '/placeholder-artist.png';

      publisherList.push({
        id: `artist-${artistKey.replace(/\s+/g, '-')}`,
        title: artistName,
        feedGuid: `artist-${artistKey.replace(/\s+/g, '-')}`,
        originalUrl: null,
        image,
        description: `${albums.length} releases, ${trackCount} tracks`,
        albums: [],
        itemCount: albums.length,
        totalTracks: trackCount,
        isPublisherCard: true,
        publisherUrl: `/publisher/${generateAlbumSlug(artistName)}`
      });
    }

    // Sort alphabetically by title
    const sortedList = publisherList.sort((a, b) => a.title.localeCompare(b.title));

    console.log(`✅ Publishers API: Returning ${sortedList.length} publishers derived from ${albumFeeds.length} album feeds`);

    const response = {
      publishers: sortedList,
      total: sortedList.length,
      timestamp: new Date().toISOString()
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=300, s-maxage=600',
        'ETag': `"${Date.now()}"`,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      },
    });
  } catch (error) {
    console.error('Unexpected error in publishers API:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? (error as Error).message : 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
