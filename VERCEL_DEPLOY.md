# Vercel test deploy (Nostr sign-in only)

This branch ships a standalone test page at **`/nostr-test`** so you can
exercise the full Nostr login + signing pipeline on Vercel without standing up
a Postgres database. Production runs on Railway with the full DB-backed flow;
this is for debugging `login works / later signing fails` class bugs in
isolation.

## What's different from the Railway build

- `/api/nostr/auth/login` detects an empty `DATABASE_URL` and skips every
  Prisma call, synthesizing the user record from the signed event + the
  Nostr profile fetched from public relays. See `DB_DISABLED` in
  `app/api/nostr/auth/login/route.ts`.
- `/nostr-test` (`app/nostr-test/page.tsx`) renders only `LoginModal` and a
  "Test sign event" button that routes through `UnifiedSigner.signEvent`.
  This is the code path the original bug report hit — the extension fast
  path in `LoginModal.handleExtensionLogin` calls `window.nostr.signEvent`
  directly and bypasses `UnifiedSigner`, so login succeeded even while
  later signing was broken.
- Everything else in the app still tries to render normally on `/`, `/album`
  etc.; those routes will log errors without a database but they don't block
  `/nostr-test` from working.

## Deploy

1. Push the branch to GitHub and connect it as a Vercel project (Framework
   preset: Next.js).
2. **Leave `DATABASE_URL` unset.** That's the flag that turns on the
   no-DB path.
3. Do not set `NEXT_PUBLIC_NOSTR_RELAYS` unless you want to override the
   default relay list in `lib/nostr/relay.ts`.
4. Deploy. When the build finishes, open `https://<your-project>.vercel.app/nostr-test`.

That's it — no env vars required.

## Testing the fix

1. Visit `/nostr-test` in a browser with the Nostr extension you want to
   test (Alby / nos2x / NoStash), or on a phone with Amber / Primal.
2. Click **Sign in with Nostr** → pick your signer → complete the flow.
3. After the page reloads you should see your npub + avatar.
4. Click **Test sign event**. It signs a minimal `kind: 1` event through
   `UnifiedSigner.signEvent`. Before the fix in commit `8a38a7e` this was
   the step that failed for extension users with
   `"NIP-07 extension not available"` — because `NIP07Signer.isAvailable()`
   cached a one-time read of `window.nostr` on construction, and if the
   extension's content script hadn't finished injecting yet, the cache
   stuck at `false` forever.

If sign fails, grab the red error panel text — that's the single useful
datapoint we couldn't get before.

## Porting the fix back to the main (Railway) repo

The actual bug fix is entirely inside `lib/nostr/*`, and the other files
touched (CLAUDE.md, the storage/auth type unions) are harmless to merge.

```bash
# from the main repo checkout:
git remote add stablekraft-nostr-fix <this-repo-url>
git fetch stablekraft-nostr-fix
git cherry-pick 8a38a7e      # NIP07Signer + LoginType alignment
# optionally:
git cherry-pick <this commit>  # Vercel scaffolding (safe no-op on Railway)
```

The Vercel scaffolding commit is safe to merge into Railway as well — the
`DB_DISABLED` path only triggers when `DATABASE_URL` is empty, which on
Railway it never is.
