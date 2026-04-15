# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Stablekraft — Nostr Fix Fork

**Test fork** of `stablekraft-app` scoped to Nostr / NIP-46 / login-modal work. Non-Nostr gotchas (playlists, feeds, VTS, BoostBox, AutoBoost, etc.) live in the production repo at `~/Vibe/stablekraft-app/CLAUDE.md` — consult that if touching those areas.

## Commands
```
npm run dev              # Start dev server
npm run build            # Production build (prisma generate + next build --no-lint)
npm run lint             # next lint
npm run db:studio        # Open Prisma Studio
npm run db:migrate:dev   # Apply migrations locally
git push origin main     # Deploy — Vercel auto-deploys, ~2 minutes before live
```

## Boundaries
- Never commit secrets (`.env`, API keys)
- Run `npm run build` before committing
- No `src/` directory — source lives in `app/`, `lib/`, `components/`, `contexts/`

## Code Layout
- `app/` — Next.js App Router routes + API handlers (`app/api/**/route.ts`)
- `lib/nostr/` — signer, NIP-46 client, publish queue, relay manager, auth-utils, signer-nudge
- `components/Nostr/` — `LoginModal`, `Nip46Connect`, `NostrLoginInit`, hooks
- `contexts/` — `NostrContext`, `AudioContext`

## Tech Stack
Next.js 15 (App Router), React 18, TypeScript, PostgreSQL/Prisma. Nostr for auth, Lightning (Alby/WebLN) for payments.

## NIP-46 Remote Signer (Amber / Primal / bunker)
Key files: `lib/nostr/nip46-client.ts`, `lib/nostr/signer.ts` (NIP46Signer wrapper), `components/Nostr/hooks/useNip46Connection.ts`, `lib/nostr/signer-nudge.ts`. iOS Safari kills WebSocket connections after ~30s backgrounded; reconnects on `visibilitychange`. **Primal is the best iOS signer** — auto-signs with Full trust, responds <1s. Debug logging is gated behind `localStorage.setItem('nip46_debug', 'true')`.

**Performance optimization flags (default OFF)** — the four NIP-46 optimizations are each gated behind a localStorage flag so we can bisect which one is causing user-reported slowness. Turn them on one at a time from DevTools:
- `nip46_perf_adaptive_rate_limit` — adaptive per-method wall between requests (500–2000ms, tuned by observed signer response time). When OFF there is **no** client-side rate limit.
- `nip46_perf_pre_decrypted` — reuse content decrypted in the relay-subscribe callback instead of re-decrypting inside `handleRelayEvent`.
- `nip46_perf_smart_filters` — adds a tight `authors:[knownSignerPubkey]` subscription filter once the signer pubkey is known. When OFF we use only the broad `{ kinds: [24133] }` / `#p` filters.
- `nip46_perf_keypair_cache` — short-circuit the historical-keypair linear search via `lastSuccessfulKeyPairIndex`.

**Signer nudge toast** (`lib/nostr/signer-nudge.ts`): `withSignerNudge()` wraps `signEvent`/`getPublicKey`, shows dismissable toast after **4s** ("Waiting on Primal to approve…"), hard-fails at **45s**. `NIP46Signer.signEvent`/`getPublicKey` in `signer.ts` route through it automatically; direct `client.signEvent` callers in `LoginModal` also wrap manually. Throttled to 8s so bursts don't spam toasts. Pattern adapted from `soapbox-pub/ditto`.

**iOS PWA reconnect feedback**: `useNip46Connection`'s `visibilitychange` handler emits `toast.success('Signer reconnected')` on successful reconnect, or an actionable red toast with Retry on failure. No more silent hangs.

## Nostr Login Modal (`components/Nostr/LoginModal.tsx`)
**Card-menu UI** (pattern from `hzrd149/nostrudel`) — no tabs. Cards: Browser Extension (shown only if `window.nostr` detected), Bunker URI (paste `bunker://` / `nostrconnect://`), Primal QR, More options (nostr-login full UI). `view` state: `'menu' | 'bunker' | 'primal'`.

**Extension path is fast-path**: `handleExtensionLogin` calls `window.nostr.signEvent(eventTemplate)` **directly**, not through `UnifiedSigner`. Any future login UX change for extensions should keep this direct path.

**Bunker URI path**: `handlePastedUriConnect` uses a fresh `NIP46Client` + `signer.setNIP46Signer(client)` — bypasses nostr-login entirely. Most reliable iOS PWA path (relay-based, no native-app switching).

**nostr-login is lazy-init**: `components/Nostr/NostrLoginInit.tsx` exports `ensureNostrLoginInitialized()` (called on demand from `handleNostrLogin`) and `<NostrLoginAutoInit />` (mounts in `layout.tsx`, only runs `init()` if user is logged in AND `window.nostr` is absent — i.e., session-restore for nostr-login-polyfilled users). Extension users and logged-out users pay zero cost. Do **not** reintroduce eager init.

## Post-Login Flow (`lib/nostr/auth-utils.ts`)
Login flows save user data, set `localStorage['nostr_pending_favorites_sync'] = user.id`, close the modal, and reload — **no delay**. `NostrContext`'s mount effect picks up the flag, runs `syncFavoritesToNostr`, and clears it. Running sync pre-reload aborted the in-flight fetches when reload fired; deferring is cleaner and has no warning noise.

When adding new login paths (NIP-46, nostr-login, etc.), call `markFavoritesSyncPending(userId)` instead of firing sync inline.

**`LoginType` union must stay in sync across four spots** — drift breaks compilation (caught by `npm run build`'s type check, not linting). The union lives in `lib/nostr/auth-utils.ts` (`LoginType`), `lib/nostr/nip46-storage.ts` (`PreferredSigner.signerType`, `savePreferredSigner`/`getPreferredSigner` signatures), `lib/nostr/signer.ts` (5 inline `userLoginType` unions inside `UnifiedSigner`), and `lib/nostr/signer-reconnect.ts`. Also update the `saveUserData()` condition in `auth-utils.ts` that gates `savePreferredSigner()`.

## NIP-07 Extension Signer Gotcha (`lib/nostr/signer.ts`)
**Never cache `window.nostr`.** Extensions (Alby, nos2x, NoStash) inject `window.nostr` asynchronously. The `UnifiedSigner` is a module-level singleton, so if it's constructed before injection finishes, a cached `undefined` sticks forever and even `reinitialize()` can't recover because the `NIP07Signer` instance itself is memoized on `UnifiedSigner`. Symptom: login works (because `LoginModal.handleExtensionLogin` calls `window.nostr.signEvent` directly as a fast path), but every later signing attempt (boosts, favorites) fails with "NIP-07 extension not available." `NIP07Signer.getNostr()` now reads `(window as any).nostr` on every call — merely reading the property does not trigger any extension popup (only calling its methods does), so there's no cost to re-reading.

## Nostr Publish Queue & Relay Management
Favoriting saves to DB immediately, queues Nostr publish (500ms debounce). **Always call `disconnectAll()`** after publishing or WebSocket connections leak. Key files: `lib/nostr/publish-queue.ts`, `lib/nostr/relay.ts`.

**NIP-01 tag validation**: `createFavoriteEventTemplate` (in `lib/nostr/favorites.ts`) throws if `itemId` is falsy so we never publish events with `["d", null]` tags — strict relays (nsec.app) reject them with "failed to parse envelope". When adding new NIP-51/30001-style parameterized replaceable events, validate all required tag values are non-empty strings at build time, not at publish time.

**Dead-socket filtering** (`RelayManager.publish`): write relays are filtered by `relay.connected !== false` before publishing. Personal NIP-65 relays often accept connect but close the socket before publish runs → nostr-tools throws `SendingOnClosedConnection` synchronously. Each `relay.publish()` is wrapped in `Promise.resolve().then(...)` so any remaining sync throws flow cleanly through `Promise.allSettled` instead of surfacing as unhandled rejections.

## Toast API (`components/Toast.tsx`)
Event-driven via `window.dispatchEvent(new CustomEvent('toast', ...))`. Helpers `toast.success/error/warning/info(message, { duration, action })` return the toast id (string). Use `toast.dismiss(id)` to programmatically remove a toast (used by `signer-nudge.ts` to clear the "Waiting on your signer…" toast the moment signing completes). A dismiss listens for a `toast-dismiss` CustomEvent.
