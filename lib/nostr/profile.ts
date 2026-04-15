/**
 * Kind-0 profile metadata fetch (client-side).
 *
 * Used to backfill displayName/avatar/bio/lightningAddress after login. The
 * /api/nostr/auth/login route intentionally returns null profile fields to
 * keep login fast (~20ms vs the ~21s it used to take when it fetched kind-0
 * server-side). NostrContext calls fetchUserProfile() once post-reload to
 * populate the stored user record from relays.
 */

import { getDefaultRelays } from './relay';

export interface NostrProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  lud16?: string;
  lud06?: string;
  nip05?: string;
  website?: string;
  banner?: string;
}

/**
 * Fetch a user's kind-0 profile metadata from Nostr relays.
 * @param pubkey - User's hex pubkey
 * @param relays - Optional relay URL list; defaults to getDefaultRelays()
 * @returns Parsed profile JSON or null when not found / parse failure
 */
export async function fetchUserProfile(
  pubkey: string,
  relays?: string[]
): Promise<NostrProfile | null> {
  try {
    const queryRelays =
      relays && relays.length > 0 ? relays : getDefaultRelays();
    const { SimplePool } = await import('nostr-tools/pool');
    const pool = new SimplePool();

    const events = await pool.querySync(queryRelays, {
      kinds: [0],
      authors: [pubkey],
      limit: 1,
    });

    pool.close(queryRelays);

    if (!events || events.length === 0) return null;

    const event = events.sort((a, b) => b.created_at - a.created_at)[0];
    try {
      return JSON.parse(event.content) as NostrProfile;
    } catch {
      return null;
    }
  } catch (err) {
    console.warn('Failed to fetch user profile:', err);
    return null;
  }
}
