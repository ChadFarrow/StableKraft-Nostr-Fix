/**
 * Nostr Publish Queue
 * Batches favorite publishes through a single shared relay connection
 * instead of creating a new RelayManager per click.
 */

import { createFavoriteEventTemplate } from './events';
import { RelayManager, getDefaultRelays } from './relay';
import { pushCheckpoint } from './login-diagnostics';

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
let lastFailureTime = 0;

const DEBOUNCE_MS = 500;
const INTER_SIGN_DELAY_MS = 500;
const FAILURE_COOLDOWN_MS = 30000; // 30s cooldown after total relay failure

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
    // If relays recently failed entirely, skip immediately
    if (Date.now() - lastFailureTime < FAILURE_COOLDOWN_MS) {
      resolve(null);
      return;
    }
    queue.push({ type: 'favorite', favoriteType: type, itemId, title, artist, relays, resolve });
    pushCheckpoint('publish-queue.queue', {
      type: 'favorite',
      favoriteType: type,
      hasItemId: !!itemId,
      queueLength: queue.length,
    });
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
    if (Date.now() - lastFailureTime < FAILURE_COOLDOWN_MS) {
      resolve(null);
      return;
    }
    queue.push({ type: 'deletion', eventId, relays, resolve });
    pushCheckpoint('publish-queue.queue', {
      type: 'deletion',
      hasEventId: !!eventId,
      queueLength: queue.length,
    });
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
  let relayManager: RelayManager | null = null;

  try {
    // Get signer
    if (typeof window === 'undefined') {
      items.forEach(item => item.resolve(null));
      flushing = false;
      return;
    }

    const { getUnifiedSigner } = await import('./signer');
    const { ensureSignerAvailable } = await import('./signer-reconnect');
    const signer = getUnifiedSigner();

    // Use the same recovery path BoostButton uses (ensureSignerAvailable wraps
    // ensureInitialized + reinitialize + per-loginType restore for NIP-46/55/07).
    // Without this, a stale singleton (iOS WebSocket killed, page just mounted,
    // or first-flush race) silently dropped the favorite.
    const reconnect = await ensureSignerAvailable();

    pushCheckpoint('publish-queue.flush.start', {
      itemCount: items.length,
      signerAvailable: reconnect.success,
      signerType: reconnect.signerType ?? signer.getSignerType(),
      loginType: localStorage.getItem('nostr_login_type'),
    });

    if (!reconnect.success) {
      pushCheckpoint('publish-queue.signer.unavailable', {
        loginType: localStorage.getItem('nostr_login_type'),
        reconnectError: reconnect.error,
        droppedItemCount: items.length,
      });
      console.warn('⚠️ Publish queue: ensureSignerAvailable failed:', reconnect.error);
      items.forEach(item => item.resolve(null));
      flushing = false;
      return;
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
    relayManager = new RelayManager();
    const connectionResults = await Promise.allSettled(
      relayUrls.map(url => relayManager!.connect(url, { read: false, write: true }))
    );

    const successfulConnections = connectionResults.filter(r => r.status === 'fulfilled').length;
    if (successfulConnections === 0 && relayUrls.length > 0) {
      console.warn(`⚠️ Publish queue: Could not connect to any relay (0/${relayUrls.length}). Cooling down ${FAILURE_COOLDOWN_MS / 1000}s.`);
      lastFailureTime = Date.now();
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

        pushCheckpoint('publish-queue.sign.start', {
          itemIndex: i,
          itemType: item.type,
          kind: event.kind,
          tagCount: event.tags?.length ?? 0,
          signerType: signer.getSignerType(),
        });
        let signedEvent;
        try {
          signedEvent = await signer.signEvent(event);
          pushCheckpoint('publish-queue.sign.end', {
            itemIndex: i,
            itemType: item.type,
            eventId: signedEvent?.id?.slice(0, 16),
            hasSig: !!signedEvent?.sig,
          });
        } catch (signError) {
          pushCheckpoint('publish-queue.sign.error', {
            itemIndex: i,
            itemType: item.type,
            message: signError instanceof Error ? signError.message : String(signError),
            name: signError instanceof Error ? signError.name : undefined,
          });
          throw signError;
        }
        const results = await relayManager!.publish(signedEvent);
        const fulfilled = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.filter(r => r.status === 'rejected').length;
        pushCheckpoint('publish-queue.publish.end', {
          itemIndex: i,
          itemType: item.type,
          eventId: signedEvent?.id?.slice(0, 16),
          fulfilled,
          rejected,
        });
        const hasSuccess = fulfilled > 0;

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
    if (relayManager) {
      await relayManager.disconnectAll();
    }
    flushing = false;
    // If more items were queued during flush, schedule another
    if (queue.length > 0) {
      scheduleFlush();
    }
  }
}
