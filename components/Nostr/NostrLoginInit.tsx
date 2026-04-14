'use client';

import { useEffect, useRef } from 'react';

/**
 * NostrLoginInit - Initializes the nostr-login library on the client side.
 * 
 * This component loads nostr-login which polyfills window.nostr for platforms
 * that don't have browser extensions (iOS, mobile browsers). It supports:
 * - NIP-46 bunker connections
 * - NIP-07 extension detection (defers to existing extensions on desktop)
 * 
 * nostr-login is configured with noBanner so it doesn't show its own UI.
 * Instead, the LoginModal dispatches 'nlLaunch' events to trigger auth flows.
 *
 * Note: 'local' method is intentionally excluded — users must create Nostr
 * keys elsewhere. Only existing key import and bunker connections are supported.
 */
export default function NostrLoginInit() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    import('nostr-login')
      .then(async ({ init }) => {
        init({
          // Don't show the floating banner — we control the UI via LoginModal
          noBanner: true,
          // Dark theme to match stablekraft aesthetic
          theme: 'default',
          // Only allow existing key import and bunker — no local key creation
          methods: ['connect', 'extension'] as any,
        });
        console.log('✅ nostr-login initialized (iOS/mobile signer support ready)');
      })
      .catch((error) => {
        // Non-fatal — desktop users with extensions don't need this
        console.log('ℹ️ nostr-login not loaded (extensions may still work):', error?.message);
      });
  }, []);

  return null;
}
