/**
 * Client-side favorites sync utilities
 * Syncs favorites from the database to Nostr relays
 */

import { publishFavoriteTrackToNostr, publishFavoriteAlbumToNostr } from './favorites';

interface SyncResults {
  tracks: {
    total: number;
    published: number;
    skipped: number;
    failed: number;
  };
  albums: {
    total: number;
    published: number;
    skipped: number;
    failed: number;
  };
  /** True if sync was cut off by a network error (typically post-login reload). */
  interrupted?: boolean;
}

/**
 * Sync all user's favorites to Nostr
 * Fetches favorites from the database and publishes any that don't have a nostrEventId
 * @param userId - User ID to sync favorites for
 * @returns Sync results
 */
export async function syncFavoritesToNostr(userId: string): Promise<SyncResults> {
  const results: SyncResults = {
    tracks: {
      total: 0,
      published: 0,
      skipped: 0,
      failed: 0
    },
    albums: {
      total: 0,
      published: 0,
      skipped: 0,
      failed: 0
    }
  };

  try {
    // Fetch favorite tracks
    const tracksResponse = await fetch('/api/favorites/tracks', {
      headers: {
        'x-nostr-user-id': userId
      }
    });

    if (tracksResponse.ok) {
      const tracksData = await tracksResponse.json();
      const tracks = tracksData.data || [];
      results.tracks.total = tracks.length;

      // Publish each track to Nostr if not already published
      for (const track of tracks) {
        try {
          // Check if already has nostrEventId
          const checkResponse = await fetch('/api/favorites/tracks', {
            method: 'GET',
            headers: {
              'x-nostr-user-id': userId
            }
          });

          if (checkResponse.ok) {
            const checkData = await checkResponse.json();
            const existingTrack = checkData.data?.find((t: { id: string; nostrEventId?: string }) => t.id === track.id);

            if (existingTrack?.nostrEventId) {
              results.tracks.skipped++;
              continue;
            }
          }

          // Publish to Nostr
          const trackId = track.id || track.guid || track.audioUrl;
          const trackTitle = track.title;
          const artistName = track.Feed?.artist;

          if (!trackId) {
            console.warn('⚠️ Skipping favorite track with no id/guid/audioUrl:', trackTitle);
            results.tracks.failed++;
            continue;
          }

          const eventId = await publishFavoriteTrackToNostr(
            trackId,
            null, // Use unified signer (NIP-46/extension)
            trackTitle,
            artistName
          );

          if (eventId) {
            // Update the favorite with the Nostr event ID
            await fetch('/api/favorites/tracks', {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'x-nostr-user-id': userId
              },
              body: JSON.stringify({
                trackId,
                nostrEventId: eventId
              })
            });
            results.tracks.published++;
          } else {
            results.tracks.failed++;
          }
        } catch (error) {
          console.error('Error publishing track to Nostr:', error);
          results.tracks.failed++;
        }
      }
    }

    // Fetch favorite albums
    const albumsResponse = await fetch('/api/favorites/albums', {
      headers: {
        'x-nostr-user-id': userId
      }
    });

    if (albumsResponse.ok) {
      const albumsData = await albumsResponse.json();
      const albums = albumsData.data || [];
      results.albums.total = albums.length;

      // Publish each album to Nostr if not already published
      for (const album of albums) {
        try {
          // Check if already has nostrEventId
          const checkResponse = await fetch('/api/favorites/albums', {
            method: 'GET',
            headers: {
              'x-nostr-user-id': userId
            }
          });

          if (checkResponse.ok) {
            const checkData = await checkResponse.json();
            const existingAlbum = checkData.data?.find((a: { id: string; nostrEventId?: string }) => a.id === album.id);

            if (existingAlbum?.nostrEventId) {
              results.albums.skipped++;
              continue;
            }
          }

          // Publish to Nostr
          const feedId = album.feedId;
          const albumTitle = album.Feed?.title;
          const artistName = album.Feed?.artist;

          // Skip entries without a stable id — NIP-01 rejects events with
          // null/empty tag values, and there's no way to meaningfully identify
          // the album on Nostr without one. Likely indicates a partial import.
          if (!feedId) {
            console.warn('⚠️ Skipping favorite album with no feedId:', albumTitle || album.id);
            results.albums.failed++;
            continue;
          }

          const eventId = await publishFavoriteAlbumToNostr(
            feedId,
            null, // Use unified signer (NIP-46/extension)
            albumTitle,
            artistName
          );

          if (eventId) {
            // Update the favorite with the Nostr event ID
            await fetch('/api/favorites/albums', {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'x-nostr-user-id': userId
              },
              body: JSON.stringify({
                feedId,
                nostrEventId: eventId
              })
            });
            results.albums.published++;
          } else {
            results.albums.failed++;
          }
        } catch (error) {
          console.error('Error publishing album to Nostr:', error);
          results.albums.failed++;
        }
      }
    }
  } catch (error) {
    // NetworkError / AbortError during sync is almost always the post-login
    // window.location.reload() aborting in-flight fetches. Log as a warning
    // so it doesn't read as an actual failure — the sync will resume on the
    // next page load or user action.
    const message = error instanceof Error ? error.message : String(error);
    const isInterrupted =
      (error instanceof TypeError && /network|fetch/i.test(message)) ||
      (error instanceof DOMException && error.name === 'AbortError');
    if (isInterrupted) {
      results.interrupted = true;
      console.warn('⚠️ Favorites sync interrupted (likely page reload):', message);
    } else {
      console.error('Error syncing favorites to Nostr:', error);
    }
  }

  return results;
}
