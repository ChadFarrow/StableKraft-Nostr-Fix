/**
 * Nostr Publish Queue
 * Batches favorite publishes through a single shared relay connection
 * instead of creating a new RelayManager per click.
 */

import { createFavoriteEventTemplate } from './events';
import { RelayManager, getDefaultRelays } from './relay';

interface QueuedPublish {
  type: 'favorite';
  favoriteType: 'track' | 'album';
  itemId: string;
  title?: string;
  artist?: string;
  relays?: string[];
  resolve: (eventId: string | null) => void;
}

interface QueuedDeletion {
  type: 'deletion';
  eventId: string;
  relays?: string[];
  resolve: (eventId: string | null) => void;
}

type QueueItem = QueuedPublish | QueuedDeletion;

let queue: QueueItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

const DEBOUNCE_MS = 500;
const INTER_SIGN_DELAY_MS = 500;

/**
 * Queue a favorite publish. Returns a promise that resolves with the nostrEventId
 * after the batch flush, or null if publishing failed.
 */
export function queueFavoritePublish(
  type: 'track' | 'album',
  itemId: string,
  title?: string,
  artist?: string,
  relays?: string[]
): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ type: 'favorite', favoriteType: type, itemId, title, artist, relays, resolve });
    scheduleFlush();
  });
}

/**
 * Queue a favorite deletion. Returns a promise that resolves when done.
 */
export function queueFavoriteDeletion(
  eventId: string,
  relays?: string[]
): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ type: 'deletion', eventId, relays, resolve });
    scheduleFlush();
  });
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQueue();
  }, DEBOUNCE_MS);
}

async function flushQueue() {
  if (flushing || queue.length === 0) return;
  flushing = true;

  // Grab all pending items and clear the queue
  const items = queue.splice(0);

  try {
    // Get signer
    if (typeof window === 'undefined') {
      items.forEach(item => item.resolve(null));
      flushing = false;
      return;
    }

    const { getUnifiedSigner } = await import('./signer');
    const signer = getUnifiedSigner();
    await signer.ensureInitialized();

    if (!signer.isAvailable()) {
      // Try NIP-55 reconnection
      const loginType = localStorage.getItem('nostr_login_type');
      if (loginType === 'nip55') {
        try {
          const { NIP55Client } = await import('./nip55-client');
          const nip55Client = new NIP55Client();
          await nip55Client.connect();
          await signer.setNIP55Signer(nip55Client);
        } catch {
          console.warn('⚠️ Publish queue: NIP-55 reconnection failed');
          items.forEach(item => item.resolve(null));
          flushing = false;
          return;
        }
      } else {
        items.forEach(item => item.resolve(null));
        flushing = false;
        return;
      }
    }

    // Collect all relay URLs from queued items
    const { filterReachableRelays } = await import('./relay');
    const allUserRelays = items.flatMap(item => {
      const relays = 'relays' in item ? item.relays : undefined;
      return relays || [];
    });
    const userRelays = filterReachableRelays([...new Set(allUserRelays)]);
    const defaultRelays = getDefaultRelays();
    const relayUrls = [...new Set([...userRelays, ...defaultRelays])];

    // Connect ONE RelayManager for the entire batch
    const relayManager = new RelayManager();
    const connectionResults = await Promise.allSettled(
      relayUrls.map(url => relayManager.connect(url, { read: false, write: true }))
    );

    const successfulConnections = connectionResults.filter(r => r.status === 'fulfilled').length;
    if (successfulConnections === 0 && relayUrls.length > 0) {
      console.warn('⚠️ Publish queue: Could not connect to any relay');
      items.forEach(item => item.resolve(null));
      flushing = false;
      return;
    }

    console.log(`📤 Publish queue: flushing ${items.length} item(s) through ${successfulConnections} relay(s)`);

    // Sign and publish each event sequentially
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        let event: any;

        if (item.type === 'favorite') {
          event = createFavoriteEventTemplate(item.favoriteType, item.itemId, item.title, item.artist);
        } else {
          event = {
            kind: 5,
            tags: [['e', item.eventId]],
            content: '',
            created_at: Math.floor(Date.now() / 1000),
          };
        }

        const signedEvent = await signer.signEvent(event);
        const results = await relayManager.publish(signedEvent);
        const hasSuccess = results.some(r => r.status === 'fulfilled');

        if (hasSuccess) {
          console.log(`✅ Publish queue: published ${item.type} event:`, signedEvent.id);
          item.resolve(signedEvent.id);
        } else {
          console.warn(`⚠️ Publish queue: failed to publish ${item.type} event to any relay`);
          item.resolve(null);
        }
      } catch (error) {
        console.error(`❌ Publish queue: error publishing ${item.type} event:`, error);
        item.resolve(null);
      }

      // Delay between signs for NIP-46 rate limits
      if (i < items.length - 1) {
        await new Promise(resolve => setTimeout(resolve, INTER_SIGN_DELAY_MS));
      }
    }
  } catch (error) {
    console.error('❌ Publish queue: unexpected error during flush:', error);
    items.forEach(item => item.resolve(null));
  } finally {
    flushing = false;
    // If more items were queued during flush, schedule another
    if (queue.length > 0) {
      scheduleFlush();
    }
  }
}
