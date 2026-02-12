import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateAlbumSlug } from '@/lib/url-utils';

export async function GET() {
  try {
    console.log('🔍 Publishers API: Loading publishers from database');

    // Get actual publisher-type feeds from the database
    const publisherFeeds = await prisma.feed.findMany({
      where: {
        type: 'publisher',
        status: 'active'
      },
      select: {
        id: true,
        title: true,
        artist: true,
        image: true,
        originalUrl: true,
        createdAt: true,
        updatedAt: true,
      }
    });

    console.log(`📊 Found ${publisherFeeds.length} publisher feeds`);

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
        createdAt: true,
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

    // Group albums by artist name (lowercase) for lookup
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
      dateAdded: string;
    }[] = [];

    // Track which artists are covered by actual publisher feeds
    const coveredArtists = new Set<string>();

    // First: add entries from actual publisher feeds
    for (const pubFeed of publisherFeeds) {
      const artistName = pubFeed.artist || pubFeed.title;
      if (!artistName) continue;

      const artistKey = artistName.toLowerCase().trim();
      coveredArtists.add(artistKey);

      // Find matching album feeds by artist name
      const albums = artistAlbums.get(artistKey) || [];
      const trackCount = albums.reduce((sum, album) => sum + album._count.Track, 0);

      // Use publisher feed's image, fall back to most recent album image
      let image = pubFeed.image || '/placeholder-artist.png';
      if (image === '/placeholder-artist.png' && albums.length > 0) {
        const sortedAlbums = [...albums].sort((a, b) =>
          new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
        );
        image = sortedAlbums.find(a => a.image)?.image || image;
      }

      // Use the oldest album's createdAt, or publisher feed's createdAt
      let dateAdded = pubFeed.createdAt.toISOString();
      if (albums.length > 0) {
        const oldestAlbum = albums.reduce((oldest, album) =>
          new Date(album.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? album : oldest
        );
        dateAdded = oldestAlbum.createdAt.toISOString();
      }

      const displayTitle = pubFeed.title || artistName;

      publisherList.push({
        id: pubFeed.id,
        title: displayTitle,
        feedGuid: pubFeed.id,
        originalUrl: pubFeed.originalUrl,
        image,
        description: albums.length > 0
          ? `${albums.length} release${albums.length !== 1 ? 's' : ''}, ${trackCount} tracks`
          : 'Publisher feed',
        albums: [],
        itemCount: albums.length || 1,
        totalTracks: trackCount,
        isPublisherCard: true,
        publisherUrl: `/publisher/${generateAlbumSlug(displayTitle)}`,
        dateAdded
      });
    }

    // Second: add synthetic entries for artists with 2+ albums but no publisher feed
    for (const [artistKey, albums] of artistAlbums) {
      if (coveredArtists.has(artistKey)) continue;
      if (albums.length <= 1) continue;

      const artistName = albums[0].artist || 'Unknown Artist';
      const trackCount = albums.reduce((sum, album) => sum + album._count.Track, 0);

      // Use the most recent album's image as the publisher image
      const sortedAlbums = albums.sort((a, b) =>
        new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
      );
      const image = sortedAlbums.find(a => a.image)?.image || '/placeholder-artist.png';

      // Use the oldest album's createdAt as when the artist first appeared on the site
      const oldestAlbum = albums.reduce((oldest, album) =>
        new Date(album.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? album : oldest
      );
      const dateAdded = oldestAlbum.createdAt.toISOString();

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
        publisherUrl: `/publisher/${generateAlbumSlug(artistName)}`,
        dateAdded
      });
    }

    // Sort alphabetically by title
    const sortedList = publisherList.sort((a, b) => a.title.localeCompare(b.title));

    console.log(`✅ Publishers API: Returning ${sortedList.length} publishers (${publisherFeeds.length} from publisher feeds, ${sortedList.length - publisherFeeds.length} from album grouping)`);

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
