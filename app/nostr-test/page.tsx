'use client';

/**
 * Minimal Nostr sign-in + sign-event test page.
 *
 * Purpose: standalone Vercel deploys where you only want to exercise the
 * Nostr login + signing code, not the whole album/playlist app. Does not
 * hit the DB. Works with DATABASE_URL unset — the login API route has a
 * no-DB code path that synthesizes the user from the signed event + Nostr
 * profile when DATABASE_URL is empty.
 *
 * Flow:
 *   1. Click "Sign in with Nostr" → LoginModal (all signer paths supported)
 *   2. After login + reload, this page shows pubkey/npub + profile
 *   3. "Test sign event" lets you exercise UnifiedSigner end-to-end, which
 *      is what caught the NIP07Signer cache bug (login worked, later
 *      signing blew up with "NIP-07 extension not available").
 */

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { useNostr } from '@/contexts/NostrContext';
import { getUnifiedSigner } from '@/lib/nostr/signer';

const LoginModal = dynamic(() => import('@/components/Nostr/LoginModal'), {
  ssr: false,
});

type SignResult =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; id: string; sig: string; pubkey: string; durationMs: number }
  | { status: 'err'; message: string };

export default function NostrTestPage() {
  const { user, isAuthenticated, isLoading, logout } = useNostr();
  const [showModal, setShowModal] = useState(false);
  const [signResult, setSignResult] = useState<SignResult>({ status: 'idle' });

  const handleTestSign = async () => {
    setSignResult({ status: 'pending' });
    const started = Date.now();
    try {
      const signer = getUnifiedSigner();
      await signer.ensureInitialized();

      if (!signer.isAvailable()) {
        // Try once to recover in case the signer cached a stale state
        const { ensureSignerAvailable } = await import(
          '@/lib/nostr/signer-reconnect'
        );
        const result = await ensureSignerAvailable();
        if (!result.success) {
          throw new Error(result.error || 'No signer available');
        }
      }

      const event = {
        kind: 1 as const,
        tags: [['t', 'stablekraft-nostr-test']],
        content: 'stablekraft nostr-test sign check @ ' + new Date().toISOString(),
        created_at: Math.floor(Date.now() / 1000),
        pubkey: user?.nostrPubkey || '',
        id: '',
        sig: '',
      };

      const signed = await signer.signEvent(event as any);
      setSignResult({
        status: 'ok',
        id: signed.id,
        sig: signed.sig,
        pubkey: signed.pubkey,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      setSignResult({
        status: 'err',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Nostr sign-in test</h1>
          <p className="text-sm text-gray-400 mt-1">
            Standalone page for exercising the login + signing flow without
            the rest of the app.
          </p>
        </header>

        {isLoading ? (
          <p className="text-gray-400">Loading…</p>
        ) : isAuthenticated && user ? (
          <section className="space-y-4 bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-3">
              {user.avatar && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatar}
                  alt=""
                  className="w-10 h-10 rounded-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold truncate">
                  {user.displayName || 'Unnamed'}
                </p>
                <p className="text-xs text-gray-400 font-mono truncate">
                  {user.nostrNpub}
                </p>
              </div>
            </div>

            <dl className="text-xs space-y-1">
              <div className="flex gap-2">
                <dt className="text-gray-500 w-28 shrink-0">Login type</dt>
                <dd className="font-mono">{user.loginType || 'unknown'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-gray-500 w-28 shrink-0">Pubkey (hex)</dt>
                <dd className="font-mono break-all">{user.nostrPubkey}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-gray-500 w-28 shrink-0">Relays</dt>
                <dd className="font-mono">
                  {user.relays?.length
                    ? user.relays.length + ' relay(s)'
                    : 'none'}
                </dd>
              </div>
            </dl>

            <div className="flex gap-2">
              <button
                onClick={handleTestSign}
                disabled={signResult.status === 'pending'}
                className="flex-1 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {signResult.status === 'pending'
                  ? 'Signing…'
                  : 'Test sign event'}
              </button>
              <button
                onClick={logout}
                className="px-4 py-2 rounded-md bg-red-600/20 border border-red-700 text-red-200 hover:bg-red-600/30"
              >
                Logout
              </button>
            </div>

            {signResult.status === 'ok' && (
              <div className="text-xs font-mono bg-green-900/20 border border-green-700 text-green-200 p-3 rounded space-y-1">
                <p className="font-semibold">
                  Signed OK in {signResult.durationMs} ms
                </p>
                <p className="break-all">id: {signResult.id}</p>
                <p className="break-all">sig: {signResult.sig.slice(0, 32)}…</p>
                <p className="break-all">pubkey: {signResult.pubkey}</p>
              </div>
            )}
            {signResult.status === 'err' && (
              <div className="text-xs font-mono bg-red-900/20 border border-red-700 text-red-200 p-3 rounded">
                <p className="font-semibold mb-1">Sign failed</p>
                <p className="break-all">{signResult.message}</p>
              </div>
            )}
          </section>
        ) : (
          <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
            <p className="text-gray-300">Not signed in.</p>
            <button
              onClick={() => setShowModal(true)}
              className="w-full px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 font-medium"
            >
              Sign in with Nostr
            </button>
          </section>
        )}

        <details className="text-xs text-gray-400 bg-gray-900/60 border border-gray-800 rounded p-3">
          <summary className="cursor-pointer">Debug tips</summary>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>
              Enable NIP-46 verbose logs:{' '}
              <code className="text-gray-200">
                localStorage.setItem(&apos;nip46_debug&apos;, &apos;true&apos;)
              </code>{' '}
              then reload and retry login.
            </li>
            <li>
              The &quot;Test sign event&quot; button routes through{' '}
              <code>UnifiedSigner.signEvent</code>, which is where the
              NIP07Signer cache bug surfaced — direct{' '}
              <code>window.nostr.signEvent</code> calls (the login fast path)
              always worked.
            </li>
            <li>
              If <code>DATABASE_URL</code> is unset, the login API skips
              Prisma and synthesizes the user from the signed event + Nostr
              profile.
            </li>
          </ul>
        </details>
      </div>

      {showModal && <LoginModal onClose={() => setShowModal(false)} />}
    </main>
  );
}
