# Lightning Payment Implementation Overview

## Core Architecture

The system is built around **3 payment methods** with intelligent fallback chains:

1. **Value Splits** (multi-recipient keysend/LNURL) — highest priority
2. **Lightning Address** (LNURL-pay) — single recipient
3. **Node Pubkey** (keysend) — direct node-to-node

## Key Files

| Area | Files |
|------|-------|
| **Config** | `lib/lightning/config.ts` — feature flags, defaults (21/100/500 sat presets), platform fee (2 sats + 1%) |
| **Wallet** | `components/Lightning/BitcoinConnectProvider.tsx` — connection management, balance polling, keysend detection |
| **Wallet Detection** | `lib/lightning/wallet-detection.ts` — provider identification (Coinos, Alby, Alby Hub, NWC, extension) |
| **V4V Parsing** | `lib/lightning/value-parser.ts` — parses `<podcast:value>` tags from RSS feeds |
| **Value Splits** | `lib/lightning/value-splits.ts` — multi-recipient payment distribution with fallback logic |
| **LNURL** | `lib/lightning/lnurl.ts` — Lightning Address resolution, invoice generation, payment verification |
| **BoostBox** | `lib/lightning/boostbox.ts` — stores boost metadata for LNURL payments (client-only, uses server proxy) |
| **Boost UI** | `components/Lightning/BoostButton.tsx` — complete boost modal with amount, message, sender name, split details |
| **Wallet UI** | `components/Lightning/LightningWalletButton.tsx`, `WalletInfoDisplay.tsx` — wallet dropdown, balance, fund wallet QR |

## API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/lightning/boostbox` | Server proxy for BoostBox (hides API key) |
| `POST /api/lightning/lnurl/resolve` | CORS proxy for LNURL/Lightning Address resolution |
| `POST /api/lightning/lnurl/invoice` | CORS proxy for invoice requests |
| `POST /api/lightning/lnurl/verify` | CORS proxy for payment verification |
| `GET /api/lightning/value-splits` | Query V4V data from DB by feedGuid/itemGuid/trackId |
| `POST /api/lightning/log-boost` | Log boost transactions |

## Payment Flow (Value Splits)

This is the most common path — multi-recipient payments using Podcasting 2.0 value tags:

```
User clicks Boost → Wallet connects (if needed) →
  Modal opens with split details →
  Resolve each recipient's Lightning Address (keysend fallback + Nostr pubkeys) →
  User enters amount/message/name →
  Build Helipad metadata (single helper for all paths) →
  Send to each recipient sequentially:
    keysend first → fall back to LNURL (with BoostBox metadata) →
  Send 2 sat platform fee metaboost →
  Log boost → Post to Nostr (kind 1 with musician p-tags) →
  Confetti → Close modal
```

## Payment Flow (Lightning Address / LNURL-pay)

```
User clicks Boost →
  Resolve Lightning Address to LNURL params (includes Nostr info) →
  Get Helipad metadata from BoostBox →
  Request invoice with BoostBox comment →
  Send payment via WebLN →
  Send platform fee metaboost →
  Log boost → Post to Nostr (with musician p-tag) →
  Show success
```

## Payment Flow (Node Pubkey / Keysend)

```
User clicks Boost →
  Build Helipad metadata →
  Send keysend with TLV custom records →
  Send platform fee metaboost →
  Log boost → Post to Nostr →
  Show success
```

## BoostBox Integration

Since LNURL payments can't carry TLV records like keysend, **BoostBox** acts as a metadata bridge:

- Helipad metadata is POSTed to BoostBox → returns a short URL
- URL is embedded in the LNURL invoice comment: `rss::payment::boost https://boostbox.cloud/boost/[ID] message`
- Recipients can fetch full payment context from that URL
- Graceful degradation — if BoostBox is down, payments proceed without metadata
- Client-only (`boostbox.ts`) — always uses the `/api/lightning/boostbox` server proxy (no API keys in client bundle)

## Keysend Custom Records (TLV)

| TLV ID | Content |
|--------|---------|
| **34349334** | Boostagram message (plaintext) |
| **7629169** | Helipad metadata (JSON) |

### Helipad Metadata Fields

- **Core**: `podcast`, `episode`, `action`, `value_msat`, `value_msat_total`, `sender_name`, `app_name`, `app_version`
- **Optional**: `message`, `url`, `feed`, `feedId`, `album`
- **Identifiers**: `episode_guid`, `remote_item_guid`, `remote_feed_guid`, `publisher_guid`
- **UUID**: unique identifier for each boost

Built by `buildHelipadMetadata()` in `BoostButton.tsx` — single helper used by all 3 payment paths. Platform fee metaboost builds its own metadata separately.

## Wallet-Specific Handling

### Coinos (Custodial)
- Slower — 300ms between split payments
- 3 retries with 4s/6s/8s delays
- 30s payment timeouts

### Alby Extension
- Auto-connects via `window.webln` when Nostr is authenticated with NIP-07
- Keysend inferred from provider type (never probed — avoids payment popup on every page load)

### Others (Alby Hub, NWC, etc.)
- 100ms between split payments
- 15s payment timeouts

## Wallet Detection & Connection

`BitcoinConnectProvider.tsx` manages the full wallet lifecycle:

- **Connection**: Bitcoin Connect modal, auto-reconnect on `onConnected` events
- **Manual disconnect tracking**: `wallet_manually_disconnected` localStorage flag prevents auto-reconnect
- **Android restore**: `wallet_restore_after_login` handles wallet restoration after Nostr login
- **Alby auto-connect**: When Nostr is authenticated via NIP-07, Alby extension connects automatically
- **Auto-disconnect on logout**: Wallet disconnects when user logs out of Nostr
- **Skips auto-connect**: For NIP-05 (read-only) and NIP-46 (Amber) logins

### Keysend Detection

Inferred from provider type — never probed with real payments:
```
supportsKeysend = hasKeysendMethod && type !== 'unknown'
```

### Balance Polling
- Fetches on connection
- Polls every 60 seconds if wallet supports `getBalance()`
- Manual refresh available

## Nostr Integration

After a successful boost, optionally posts a **kind 1** Nostr event with:

- Amount tag (millisats), preimage, image
- Podcast identifier `i` tags (item GUID, feed GUID)
- Musician `p` tags (resolved from Lightning Address NIP-05)
- `@npub` mentions in content
- URL reference `r` tag

Signed with unified signer (NIP-07, NIP-46, NIP-55) and posted via `/api/nostr/boost`. Non-fatal — doesn't break the payment if posting fails.

## Feature Flags

Defined in `LIGHTNING_CONFIG.features` (`lib/lightning/config.ts`):

| Flag | Default | Description |
|------|---------|-------------|
| `webln` | true | WebLN provider support |
| `nwc` | true | Nostr Wallet Connect support |
| `lightningAddress` | true | Lightning Address support |
| `keysend` | true | Keysend payment support |
| `autoBoost` | true | Auto-boost on song end |
| `boostagrams` | true | Send messages with boosts |
| `nostrIntegration` | true | Post boosts to Nostr |
| `helipadIntegration` | false | Helipad integration (disabled until configured) |
| `boostbox` | true | BoostBox metadata storage |

## Error Handling

Translates raw Lightning errors into user-friendly messages:

| Error | Message |
|-------|---------|
| No Route | "Cannot find payment route - recipient may be offline" |
| Insufficient Balance | "Insufficient balance in your Lightning wallet" |
| Timeout | "Payment timed out - recipient may be experiencing issues" |
| Invoice Expired | "Invoice has expired - please request a new invoice" |
| User Rejected | "Payment cancelled by user" |
| Keysend Not Supported | "Keysend is not supported by your wallet. Try Alby or Coinos via NWC." |
| Network Error | "Network error - check your connection" |
| Server Error | "Recipient server error - they may be experiencing downtime" |

Retry logic: 2-3 retries for routing failures (1s delay), 1-2 retries for timeouts.

## Wallet UI Components

### LightningWalletButton (`components/Lightning/LightningWalletButton.tsx`)
- Three variants: minimal (icon only), button, dropdown
- Dropdown shows wallet info via `WalletInfoDisplay`
- Actions: Switch Wallet, Disconnect Wallet

### WalletInfoDisplay (`components/Lightning/WalletInfoDisplay.tsx`)
- Three variants: compact (inline), full (dropdown), card (settings page)
- Shows: provider, balance (with refresh), Lightning Address, external link
- **Fund Wallet** modal: amount input → generate invoice QR → copy invoice → auto-detect payment via balance polling (3s intervals)
