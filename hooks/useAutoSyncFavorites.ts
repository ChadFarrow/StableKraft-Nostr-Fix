'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useNostr } from '@/contexts/NostrContext';
import { toast } from '@/components/Toast';
import { batchPublishFavoritesToNostr, BatchPublishItem } from '@/lib/nostr/favorites';

interface UseAutoSyncFavoritesOptions {
  enabled?: boolean;
  onSyncComplete?: () => void;
}

/**
 * Hook to auto-sync unpublished favorites to Nostr when authenticated.
 * Runs on mount and retries once if the first attempt fails.
 */
export function useAutoSyncFavorites(options: UseAutoSyncFavoritesOptions = {}) {
  const { enabled = true, onSyncComplete } = options;
  const { user, isAuthenticated } = useNostr();

  const isSyncingRef = useRef(false);

  // Don't sync for NIP-05 (read-only) users
  const isNip05Login = user?.loginType === 'nip05';

  const performSync = useCallback(async (): Promise<boolean> => {
    if (!user || isSyncingRef.current) return false;

    isSyncingRef.current = true;

    try {
      // Check unpublished count first
      const countResponse = await fetch('/api/favorites/unpublished-count', {
        headers: {
          'x-nostr-user-id': user.id
        }
      });

      if (!countResponse.ok) {
        return false;
      }

      const countData = await countResponse.json();
      const unpublishedCount = countData.success ? countData.unpublished?.total || 0 : 0;

      if (unpublishedCount === 0) {
        return true; // Nothing to sync — success
      }

      // Fetch favorites to sync
      const response = await fetch('/api/favorites/sync-to-nostr', {
        headers: {
          'x-nostr-user-id': user.id
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch favorites');
      }

      const data = await response.json();
      if (!data.success || !data.items || data.items.length === 0) {
        return true;
      }

      const items: BatchPublishItem[] = data.items;

      // Get user's relays if available
      const userRelays = user.relays && user.relays.length > 0 ? user.relays : undefined;

      // Batch publish to Nostr
      const result = await batchPublishFavoritesToNostr(
        items,
        undefined,
        userRelays
      );

      // Update database with nostrEventIds in batches
      const batchSize = 10;
      for (let i = 0; i < result.successful.length; i += batchSize) {
        const batch = result.successful.slice(i, i + batchSize);
        const batchPromises = batch.map(async (item) => {
          const originalItem = items.find(it => it.id === item.id);
          if (originalItem) {
            try {
              await fetch('/api/favorites/sync-to-nostr', {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'x-nostr-user-id': user.id
                },
                body: JSON.stringify({
                  type: originalItem.type,
                  id: item.id,
                  nostrEventId: item.nostrEventId
                })
              });
            } catch (error) {
              console.error('Failed to update database with nostrEventId:', error);
            }
          }
        });
        await Promise.allSettled(batchPromises);
      }

      // Show results
      if (result.successful.length > 0 && result.failed.length === 0) {
        toast.success(`Synced ${result.successful.length} favorites to Nostr`);
      } else if (result.successful.length > 0 && result.failed.length > 0) {
        toast.warning(`Synced ${result.successful.length} favorites, ${result.failed.length} failed`);
      }

      // Notify parent
      if (onSyncComplete) {
        onSyncComplete();
      }

      // Notify SyncToNostrButton to re-fetch counts
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('favorites-synced'));
      }

      return result.failed.length === 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Don't log relay connection errors as loud errors
      if (errorMsg.includes('relay') || errorMsg.includes('connect')) {
        console.warn('Auto-sync skipped: relay connection unavailable');
      } else {
        console.error('Auto-sync favorites error:', error);
      }
      return false;
    } finally {
      isSyncingRef.current = false;
    }
  }, [user, onSyncComplete]);

  useEffect(() => {
    if (!enabled || !isAuthenticated || !user || isNip05Login) {
      return;
    }

    let cancelled = false;

    const runSync = async () => {
      // Delay to ensure signer is initialized
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (cancelled) return;

      await performSync();
    };

    runSync();

    return () => { cancelled = true; };
  }, [enabled, isAuthenticated, user, isNip05Login, performSync]);
}
