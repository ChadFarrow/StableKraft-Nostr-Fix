# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Stablekraft — Nostr Fix Fork

**Test fork** of `stablekraft-app` scoped to Nostr / NIP-46 / login-modal work. Non-Nostr gotchas (playlists, feeds, VTS, BoostBox, AutoBoost, etc.) live in the production repo at `~/Vibe/stablekraft-app/CLAUDE.md` — consult that if touching those areas.

## Major changes from Nostr-Fix fork (port to prod)

All five commits below fix real bugs or regressions discovered while testing each LoginModal sign-in card one at a time against live signers. Port in order — they layer on the same files. Apply cleanly via `git cherry-pick <hash>` from this fork if the production branch hasn't drifted.

### 1. `7f77d812` — perf: skip server-side profile/relay fetch during login
**File:** `app/api/nostr/auth/login/route.ts`
Removes the `NostrClient` + `getDefaultRelays` import and the try-block that called `getProfile` + `getRelayList` on every login. Replace with null profile fields; repeat-logins only refresh `nostrNpub` (never overwrite existing `displayName/avatar/bio/lightningAddress` with nulls).
**Why:** server login was taking ~21s (measured 21,080ms). Client already fetches NIP-65 itself after redirect via `NostrContext` + `nip65.ts`, so server-side relay round-trip was pure waste. Now 20ms.

### 2. `c3c81940` — perf: show NIP-46 QR instantly
**File:** `lib/nostr/nip46-client.ts`
In the connection-setup path (around line 770, `startRelayConnection`): await only the primary relay; fire backup-relay connects in background (`.then(...).catch(...)` without `await`); delete the 500–1000ms post-connect `setTimeout` before subscribing.
**Why:** Primal/Amber QR took ~6s to appear (measured 6,061ms). Now 466ms.

### 3. `085d8387` — fix: persist Amber NIP-46 login across reload (+ 5 console.error→log)
**Files:** `components/Nostr/LoginModal.tsx`, `lib/nostr/nip46-client.ts`
- LoginModal: in the NIP-46 `if (loginData.success) { ... }` branch, drop the "Connection pubkey doesn't match logged-in user — Not saving connection" early return. Instead **normalize** `connection.pubkey = loginData.user.nostrPubkey` and fall through to the save block. For Amber, the connect-response event sender is Amber's per-session signer-app key (e.g. `86e106ca…`), NOT the user's Nostr account pubkey (`f7922a0adb…`). Server verifies signature against the user pubkey; trust that.
- nip46-client: downgrade five informational logs in `handleRelayEvent` / `sendRequest` from `console.error` → `console.log`:
  - `[NIP46-CONNECT] Stored signer's pubkey for event filtering: …`
  - `[NIP46-SUCCESS] Got public key from Amber: …`
  - `[NIP46-SUCCESS] Using user's pubkey: …`
  - `[NIP46-SIGN] Using pubkey for signing: …`
  - `[NIP46-SIGN] Pubkey converts to npub: …`
**Why:** Without normalization, Amber login 200-OK'd server-side but then the mismatch check skipped `localStorage.setItem('nostr_user', …)` → user appeared logged in, then logged out on the post-login reload. The console.error escalations cause Next.js 15 dev overlay to pop a red "Console Error" on every successful Amber login.

### 4. `753446cd` — fix: make bunker:// URI flow robust to multi-relay signer URIs
**Files:** `lib/nostr/nip46-client.ts`, `components/Nostr/LoginModal.tsx`, `components/Nostr/hooks/useNip46Connection.ts`
- nip46-client: for `isBunkerConnection`, replace "await primary only, publish to primary only, subscribe to primary only" with **"connect all URI relays in parallel, succeed if any open; publish + subscribe on every URI relay."** Specifically:
  - `startRelayConnection`: when `isBunkerConnection`, parse `bunkerInfo.relays` and await `connectToRelays(subscribeRelays)`; succeed if any one of them opens (for Aegis-style single-relay bridges this is still fine — the single URI relay is in the list).
  - subscription filter: `subscribeRelays` = all URI relays for bunker, was `[relayUrl]`.
  - publish path (around line 3340): when `isBunkerConnection`, `publishRelays = bunkerInfo.relays`; was hardcoded to `[primaryRelay]` with a "Bunker signers only listen to their specific relay" comment that only applied to Aegis.
- LoginModal: strip nsec.app/Alby.to/Keycast from user-facing copy (unverified/dead as of April 2026). Add an amber-colored note on the Bunker URI view directing Android users to the dedicated Amber card instead and linking upstream [greenart7c3/Amber#251](https://github.com/greenart7c3/Amber/issues/251).
**Why:** Amber embeds 5 relays in its `bunker://` URIs (primal, ditto, nsec.app, theforest, nostr.oxtr) and the signer may respond on any of them. Publishing/subscribing to only the first relay loses responses. Also, when primary is blocked by the browser (Firefox blocks relay.primal.net with `NS_ERROR_WEBSOCKET_CONNECTION_REFUSED`), the old code aborted; new code tries all in parallel.

### 5. `43a479d5` — remove: 'More options' card (nostr-login) from LoginModal
**Files:** `components/Nostr/LoginModal.tsx`, `components/Nostr/NostrLoginInit.tsx`
- LoginModal: delete the `handleNostrLogin` function, the "More options" card `<button>` in the menu grid, and the `ensureNostrLoginInitialized` import.
- NostrLoginInit: keep the file as-is — `NostrLoginAutoInit` is still used in `app/layout.tsx` for session-restore of legacy users who previously logged in via nostr-login.
**Why:** With `noBanner: true`, nostr-login mounts `<nl-banner>` (in hidden state) but never mounts `<nl-auth>` (the modal). Dispatching `nlLaunch` fires the library's internal launch event but no visible UI appears — click just dismissed our modal with nothing rendered. The other 4 cards (Extension, Bunker URI, Amber, Primal) cover every real signer path; nostr-login was a leaky abstraction over features we already built.

### Card count: 4, not 5
After change #5 the LoginModal has **4** cards: Browser Extension, Bunker URI, Amber (Android), Primal. The `LoginType` union and all signer wiring stays the same — only the "More options" entry was removed from the menu grid.

### Android recommendation
Direct Android users to the **Amber card** (`nostrconnect://` deep-link, works reliably end-to-end). The Bunker URI card now displays a note warning Android users away because Amber's `bunker://` export is unreliable upstream — per issue #251, Amber's NIP-46 subscription silently stops responding for later `sign_event` requests even though initial `connect` and `get_public_key` work. This is not fixable from our side.

### Aegis (iOS self-hosted signer) limitation
Aegis (`ZharlieW/Aegis`) runs a local relay on the device (`localrelay.link:28443` → TLS proxy to `ws://127.0.0.1:8081`). Its `bunker://` URIs do **not** include a `secret=` parameter. Our bunker path correctly publishes `connect`, `get_public_key`, and `sign_event` to the Aegis relay — all three are accepted (relay ACKs `fulfilled:1`). However, **Aegis silently drops `sign_event` requests from clients that haven't proved authorization via a secret**, even though it happily signs `connect` and `get_public_key`. This was confirmed via checkpoint diagnostics (April 2026): the relay receives the event, Aegis processes connect/get_public_key, but never responds to sign_event.

**Mitigations shipped:**
- Bunker URI card shows an amber warning when no `secret=` is detected in the pasted URI, directing users to Primal.
- `LoginModal` applies a 25s fail-fast (`Promise.race`) for bunker URIs without a secret, instead of the normal 125s `withSignerNudge` hard-timeout.
- `pushCheckpoint()` instrumentation logs every login step directly to the diagnostics ring buffer (bypasses `console.log` patching that was losing entries on iOS remounts).

**Recommendation for Aegis users:** use the **Primal card** instead — it's the known-good iOS signer (auto-signs, sub-second). If Aegis ever adds `secret=` to its bunker URI export, the Bunker URI card will work without changes on our side.

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

**Signer nudge toast** (`lib/nostr/signer-nudge.ts`): `withSignerNudge()` wraps `signEvent`/`getPublicKey`, shows dismissable toast after **4s** ("Waiting on Primal to approve…"), hard-fails at **125s** (set slightly above the client's 120s request timeout so the underlying timeout fires first with troubleshooting tips). `NIP46Signer.signEvent`/`getPublicKey` in `signer.ts` route through it automatically; direct `client.signEvent` callers in `LoginModal` also wrap manually. Throttled to 8s so bursts don't spam toasts. Pattern adapted from `soapbox-pub/ditto`. For bunker URIs without a `secret=` param, `LoginModal` applies a tighter **25s** fail-fast via `Promise.race` (see Aegis limitation above).

**iOS PWA reconnect feedback**: `useNip46Connection`'s `visibilitychange` handler emits `toast.success('Signer reconnected')` on successful reconnect, or an actionable red toast with Retry on failure. No more silent hangs.

## Nostr Login Modal (`components/Nostr/LoginModal.tsx`)
**Card-menu UI** (pattern from `hzrd149/nostrudel`) — no tabs. **4 cards**: Browser Extension (shown only if `window.nostr` detected), Bunker URI (paste `bunker://` / `nostrconnect://`), Amber (Android, `nostrconnect://` deep-link + QR), Primal (iOS remote signer / desktop QR). `view` state: `'menu' | 'bunker' | 'primal' | 'amber'`.

**Extension path is fast-path**: `handleExtensionLogin` calls `window.nostr.signEvent(eventTemplate)` **directly**, not through `UnifiedSigner`. Any future login UX change for extensions should keep this direct path.

**Bunker URI path**: `handlePastedUriConnect` uses a fresh `NIP46Client` + `signer.setNIP46Signer(client)` — bypasses nostr-login entirely. For multi-relay `bunker://` URIs (Amber embeds 5), the underlying `NIP46Client.startRelayConnection` connects/subscribes/publishes to **all** URI relays, not just the first — see `lib/nostr/nip46-client.ts` and changelog entry #4 above. Do **not** regress to primary-only.

**Amber pubkey normalization** (critical, see changelog #3): for NIP-46/Amber, the connect-response event's `event.pubkey` is the signer app's per-session key (e.g. `86e106ca…`), NOT the user's Nostr account pubkey (`f7922a0adb…`). The user pubkey arrives later via `get_public_key` or the `sign_event` response. The post-login save block in `LoginModal.tsx` **must not** treat the difference as a mismatch — instead, normalize `connection.pubkey = loginData.user.nostrPubkey` and fall through to save. Reintroducing a mismatch early-return breaks Amber reload persistence.

**Android recommendation**: direct Android users at the Amber card (`nostrconnect://` flow, works end-to-end). The Bunker URI card shows an in-UI warning pointing Android users away from pasted-`bunker://` because Amber's bunker hosting is unreliable upstream (greenart7c3/Amber#251).

**nostr-login is session-restore only**: `components/Nostr/NostrLoginInit.tsx` exports `ensureNostrLoginInitialized()` and `<NostrLoginAutoInit />` (mounts in `layout.tsx`, only runs `init()` if user is logged in AND `window.nostr` is absent — i.e., session-restore for nostr-login-polyfilled legacy users). **There is no longer a "More options" card** — nostr-login's auth UI isn't reachable from LoginModal for new logins because with `noBanner: true` the library never mounts `<nl-auth>`. Do **not** reintroduce the More options card or a `handleNostrLogin` function. Extension users and logged-out users pay zero cost.

## Profile Backfill (`lib/nostr/profile.ts`, `contexts/NostrContext.tsx`)
The server login route (`/api/nostr/auth/login`) intentionally returns `displayName: null`, `avatar: null`, etc. — skipping the kind-0 relay fetch keeps login at ~20ms (was ~21s). `NostrContext`'s mount effect backfills the profile client-side: when the stored user has no `displayName`, it calls `fetchUserProfile(pubkey)` (a lightweight `SimplePool.querySync` for kind-0, same pattern as `nip65.ts`). The result merges into state + localStorage without overwriting already-populated fields. Without this, `UserMenu.tsx` shows "User" as the display name until the user manually visits Settings.

## Login Diagnostics (`lib/nostr/login-diagnostics.ts`)
Mobile-friendly capture for Nostr sign-in failures. `installConsoleCapture()` patches `console.log/warn/error` to feed a ring buffer (200 entries). `pushCheckpoint(label, data?)` writes **directly** to the buffer, bypassing the console patch — use this for must-not-be-lost events (the console patch can be lost to remounts / fast-refresh). Checkpoints are emitted at key login milestones: `bunker.connect.{start,complete}`, `login.challenge.fetch.{start,end}`, `login.signEvent.{start,end,error}`, `nip46.signEvent.enter`, `nip46.publish.{start,end}`. The report is built by `buildDiagnosticsReport()` and copied to clipboard via the footer button in LoginModal.

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
