'use client';

import { useEffect } from 'react';

/**
 * Lazy initializer for the nostr-login library.
 *
 * nostr-login polyfills window.nostr for users without a browser extension
 * (iOS, mobile, nsec-based auth, bunker connections). But initializing it
 * on every page load imports the bundle and opens background WebSocket
 * connections to default relays — which slows page loads and, crucially,
 * makes NIP-07 extension sign-ins feel sluggish.
 *
 * We now init in two modes:
 *   1. `ensureNostrLoginInitialized()` — explicit, called from the login
 *      handler right before dispatching `nlLaunch`.
 *   2. `<NostrLoginAutoInit />` — auto-init ONLY when there's no real
 *      window.nostr AND the user has a stored session (so nostr-login can
 *      restore the polyfilled window.nostr for signing).
 *
 * Extension users and logged-out users pay zero nostr-login cost on page
 * load.
 */

let initPromise: Promise<void> | null = null;

export function ensureNostrLoginInitialized(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = import('nostr-login')
    .then(({ init }) => {
      init({
        // Don't show the floating banner — we control the UI via LoginModal
        noBanner: true,
        // Dark theme to match stablekraft aesthetic
        theme: 'default',
        // Include enough methods that the welcome screen always has something
        // to render. `connect` alone relies on nsec.app which is currently
        // down; `extension` requires a NIP-07 extension. Add `readOnly`
        // (paste npub), and `local` (import nsec) so users see options.
        methods: ['connect', 'extension', 'readOnly', 'local'] as any,
      });
      console.log('✅ nostr-login initialized');
    })
    .catch((error) => {
      // Reset so a later attempt can retry (e.g., flaky network)
      initPromise = null;
      console.log('ℹ️ nostr-login failed to load:', error?.message);
      throw error;
    });

  return initPromise;
}

/**
 * Auto-init nostr-login on mount ONLY if the user likely needs it for session
 * restoration. Skipped for users with real NIP-07 extensions (they already
 * have window.nostr) and for logged-out users (nothing to restore).
 */
export default function NostrLoginAutoInit() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Real extension is already providing window.nostr — skip.
    if ((window as any).nostr) return;
    // No stored login — defer until the user explicitly chooses nostr-login.
    if (!localStorage.getItem('nostr_user')) return;
    // Stored login but no window.nostr → likely logged in via nostr-login
    // (nsec/bunker). Init so signing works on this page.
    ensureNostrLoginInitialized().catch(() => {});
  }, []);
  return null;
}
