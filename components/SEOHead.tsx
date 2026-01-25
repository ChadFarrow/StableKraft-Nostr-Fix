import { Metadata } from 'next';

interface SEOHeadProps {
  title: string;
  description: string;
  image?: string;
  type?: 'website' | 'music.album' | 'music.song';
  url?: string;
  duration?: number;
  artist?: string;
  albumName?: string;
}

/**
 * Generate enhanced SEO metadata with Open Graph and Twitter Cards
 */
export function generateSEOMetadata({
  title,
  description,
  image = '/logo.webp',
  type = 'website',
  url,
  duration,
  artist,
  albumName,
}: SEOHeadProps): Metadata {
  const siteUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://stablekraft.app';
  const fullUrl = url ? `${siteUrl}${url}` : siteUrl;
  const fullImageUrl = image.startsWith('http') ? image : `${siteUrl}${image}`;

  const metadata: Metadata = {
    title,
    description,
    metadataBase: new URL(siteUrl),
    openGraph: {
      title,
      description,
      url: fullUrl,
      siteName: 'Project StableKraft',
      images: [
        {
          url: fullImageUrl,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
      locale: 'en_US',
      type: type as 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [fullImageUrl],
      creator: '@stablekraft',
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
  };

  // Add music-specific metadata if type is music
  if (type.startsWith('music.') && artist) {
    metadata.openGraph = {
      ...metadata.openGraph,
      // @ts-ignore - music types not in standard OG
      type,
      musicians: artist ? [artist] : undefined,
      duration: duration,
      album: albumName,
    };
  }

  return metadata;
}

/**
 * Generate JSON-LD structured data for music albums
 */
export function generateMusicAlbumSchema(album: {
  name: string;
  artist: string;
  image?: string;
  datePublished?: string;
  tracks?: Array<{ name: string; duration: number; url: string }>;
}) {
  const siteUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://stablekraft.app';

  return {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: album.name,
    byArtist: {
      '@type': 'MusicGroup',
      name: album.artist,
    },
    image: album.image?.startsWith('http') ? album.image : `${siteUrl}${album.image}`,
    datePublished: album.datePublished,
    numTracks: album.tracks?.length,
    track: album.tracks?.map((track, index) => ({
      '@type': 'MusicRecording',
      name: track.name,
      duration: `PT${Math.floor(track.duration / 60)}M${Math.floor(track.duration % 60)}S`,
      url: track.url,
      position: index + 1,
    })),
  };
}
