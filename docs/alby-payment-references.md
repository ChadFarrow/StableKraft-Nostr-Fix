# Alby & Lightning Payment — External References

External docs and specs used to build the Lightning payment system.

## Libraries

| Library | Repo | Usage |
|---------|------|-------|
| `@getalby/bitcoin-connect` | https://github.com/getAlby/bitcoin-connect | Wallet connection modal, WebLN provider abstraction, NWC support |
| `webln` | https://github.com/joule-labs/webln | WebLN type definitions and browser wallet interface |
| `@webbtc/webln-types` | https://github.com/nickhamer/webbtc-webln-types | Extended TypeScript types (keysend, makeInvoice, getBalance) |

## Alby APIs

| Resource | URL |
|----------|-----|
| Lightning Address Details Proxy (source) | https://github.com/getAlby/lightning-address-details-proxy |
| Lightning Address Details Proxy (endpoint) | `https://api.getalby.com/lnurl/lightning-address-details?ln=<address>` |

Resolves a Lightning Address in a single call — returns LNURL-pay params and keysend fallback info.

## BoostBox (LNURL Metadata Storage)

| Resource | URL |
|----------|-----|
| Docs | https://boostbox.cloud/docs |
| OpenAPI spec | https://boostbox.cloud/openapi.json |
| Source | https://github.com/noblepayne/boostbox |

Stores Podcasting 2.0 boost metadata for LNURL payments (which can't carry TLV records like keysend). Returns a short URL embedded in the invoice comment so recipients can fetch full payment context.

## Podcasting 2.0 / Value4Value

| Resource | URL |
|----------|-----|
| Podcast Namespace spec | https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md |
| Podcast Index API docs | https://podcastindex-org.github.io/docs-api/ |

Key tags from the namespace spec: `<podcast:value>` (V4V payment splits), `<podcast:guid>` (feed identification), `<podcast:remoteItem>` (cross-feed references).

## Protocols

### LNURL-pay
Resolution pattern: `https://<domain>/.well-known/lnurlp/<username>` (used in `lib/lightning/lnurl.ts`).

### Keysend TLV Records

| TLV ID | Content |
|--------|---------|
| `7629169` | Helipad metadata (JSON — podcast, episode, amount, sender, etc.) |
| `34349334` | Boostagram message (plaintext) |
