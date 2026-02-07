import { EventTemplate } from './events';
import { RelayManager, getDefaultRelays, filterReachableRelays } from './relay';
import { encodeNaddr } from './nip19';

const PLAYLIST_KIND = 34139;
const PLAYLIST_D_TAG = 'stablekraft-favorites';

export interface PlaylistTrack {
  title: string;
  artist?: string | null;
  guid?: string | null;
  image?: string | null;
  Feed?: {
    title?: string;
    artist?: string | null;
    image?: string | null;
    guid?: string | null;
  };
}

/**
 * Create an unsigned kind 34139 playlist event template
 */
export function createPlaylistEventTemplate(
  title: string,
  tracks: PlaylistTrack[]
): EventTemplate {
  const tags: string[][] = [
    ['d', PLAYLIST_D_TAG],
    ['title', title],
    ['alt', `Music playlist: ${title}`],
    ['t', 'playlist'],
    ['t', 'favorites'],
    ['t', 'music'],
    ['public', 'true'],
  ];

  // Use first track with a valid image as playlist image
  const playlistImage = tracks.find(t => {
    const img = t.image || t.Feed?.image;
    if (!img) return false;
    try {
      const url = new URL(img);
      return url.pathname.length > 1;
    } catch {
      return false;
    }
  });
  const imageUrl = playlistImage?.image || playlistImage?.Feed?.image;
  if (imageUrl) {
    tags.push(['image', imageUrl]);
  }

  // Add per-track i tags with Podcast Index GUIDs
  const seenFeedGuids = new Set<string>();

  for (const track of tracks) {
    // Item GUID
    if (track.guid) {
      tags.push(['i', `podcast:item:guid:${track.guid}`]);
    }

    // Feed GUID (deduplicated)
    const feedGuid = track.Feed?.guid;
    if (feedGuid && !seenFeedGuids.has(feedGuid)) {
      seenFeedGuids.add(feedGuid);
      tags.push(['i', `podcast:guid:${feedGuid}`]);
    }
  }

  // Build markdown content
  const trackLines = tracks.map(t => {
    const artist = t.artist || t.Feed?.artist || 'Unknown';
    return `${artist} - ${t.title}`;
  });

  const content = `# ${title}\n\n${trackLines.join('\n')}\n\n${tracks.length} tracks`;

  return {
    kind: PLAYLIST_KIND,
    tags,
    content,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Publish a favorites playlist to Nostr as kind 34139
 * One-shot publish (not queued)
 */
export async function publishPlaylistToNostr(
  title: string,
  tracks: PlaylistTrack[],
  relays?: string[]
): Promise<{ success: boolean; eventId?: string; naddr?: string; error?: string }> {
  try {
    if (typeof window === 'undefined') {
      return { success: false, error: 'Not in browser environment' };
    }

    const { getUnifiedSigner } = await import('./signer');
    const signer = getUnifiedSigner();

    await signer.ensureInitialized();

    if (!signer.isAvailable()) {
      const loginType = localStorage.getItem('nostr_login_type');

      if (loginType === 'nip55') {
        try {
          const { NIP55Client } = await import('./nip55-client');
          const nip55Client = new NIP55Client();
          await nip55Client.connect();
          await signer.setNIP55Signer(nip55Client);
        } catch {
          return { success: false, error: 'NIP-55 reconnection failed' };
        }
      } else {
        return { success: false, error: 'No signer available' };
      }
    }

    if (!signer.isAvailable()) {
      return { success: false, error: 'Signer not available after reconnection' };
    }

    const template = createPlaylistEventTemplate(title, tracks);
    const signedEvent = await signer.signEvent(template as any);
    const pubkey = signedEvent.pubkey;

    // Combine user relays with defaults
    const userRelays = filterReachableRelays(relays || []);
    const defaultRelays = getDefaultRelays();
    const allRelays = [...new Set([...userRelays, ...defaultRelays])];

    const relayManager = new RelayManager();

    try {
      const connectionResults = await Promise.allSettled(
        allRelays.map(url =>
          relayManager.connect(url, { read: false, write: true })
        )
      );

      const successfulConnections = connectionResults.filter(r => r.status === 'fulfilled').length;
      if (successfulConnections === 0 && allRelays.length > 0) {
        return { success: false, error: 'Could not connect to any relay' };
      }

      const results = await relayManager.publish(signedEvent);
      const hasSuccess = results.some(r => r.status === 'fulfilled');

      if (hasSuccess) {
        const successfulRelayUrls = allRelays.slice(0, 3);
        const naddr = encodeNaddr(pubkey, PLAYLIST_KIND, PLAYLIST_D_TAG, successfulRelayUrls);
        return { success: true, eventId: signedEvent.id, naddr };
      } else {
        return { success: false, error: 'Failed to publish to any relay' };
      }
    } finally {
      await relayManager.disconnectAll();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error publishing playlist to Nostr:', error);
    return { success: false, error: message };
  }
}
