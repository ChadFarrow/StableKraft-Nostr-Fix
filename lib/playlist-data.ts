import { prisma } from '@/lib/prisma';

export interface PlaylistTrackData {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  description: string | null;
  image: string | null;
  audioUrl: string;
  duration: number | null;
  publishedAt: Date | null;
  feedId: string;
  guid: string | null;
  v4vRecipient: string | null;
  v4vValue: any;
  position: number;
  episodeId: string | null;
}

export interface SystemPlaylistData {
  id: string;
  title: string;
  description: string | null;
  artwork: string | null;
  link: string | null;
  updatedAt: Date;
  tracks: PlaylistTrackData[];
}

/**
 * Get playlist data directly from the database.
 * This is the fast path - no XML fetching needed.
 */
export async function getPlaylistData(playlistId: string): Promise<SystemPlaylistData | null> {
  try {
    const playlist = await prisma.systemPlaylist.findUnique({
      where: { id: playlistId },
      include: {
        SystemPlaylistTrack: {
          orderBy: { position: 'asc' },
          include: {
            Track: {
              select: {
                id: true,
                title: true,
                artist: true,
                album: true,
                description: true,
                image: true,
                audioUrl: true,
                duration: true,
                publishedAt: true,
                feedId: true,
                guid: true,
                v4vRecipient: true,
                v4vValue: true,
              }
            }
          }
        }
      }
    });

    if (!playlist) {
      return null;
    }

    // Transform the data into the expected format
    const tracks: PlaylistTrackData[] = playlist.SystemPlaylistTrack.map(pt => ({
      id: pt.Track.id,
      title: pt.Track.title,
      artist: pt.Track.artist,
      album: pt.Track.album,
      description: pt.Track.description,
      image: pt.Track.image,
      audioUrl: pt.Track.audioUrl,
      duration: pt.Track.duration,
      publishedAt: pt.Track.publishedAt,
      feedId: pt.Track.feedId,
      guid: pt.Track.guid,
      v4vRecipient: pt.Track.v4vRecipient,
      v4vValue: pt.Track.v4vValue,
      position: pt.position,
      episodeId: pt.episodeId,
    }));

    return {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      artwork: playlist.artwork,
      link: playlist.link,
      updatedAt: playlist.updatedAt,
      tracks,
    };
  } catch (error) {
    console.error(`Error fetching playlist ${playlistId}:`, error);
    return null;
  }
}

/**
 * Check if a playlist exists in the database
 */
export async function playlistExists(playlistId: string): Promise<boolean> {
  const count = await prisma.systemPlaylist.count({
    where: { id: playlistId }
  });
  return count > 0;
}

/**
 * Get just the track count for a playlist (for quick stats)
 */
export async function getPlaylistTrackCount(playlistId: string): Promise<number> {
  return await prisma.systemPlaylistTrack.count({
    where: { playlistId }
  });
}
