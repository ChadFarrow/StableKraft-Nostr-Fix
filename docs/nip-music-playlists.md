# Music Playlists

`draft` `optional`

This spec defines an addressable event kind for publishing music playlists on Nostr, with tracks referenced via [Podcast Index](https://podcastindex.org/) GUIDs.

## Event Kind

- `34139`: Playlist (parameterized replaceable per [NIP-33](https://github.com/nostr-protocol/nips/blob/master/33.md))

## Playlist Event

A playlist is an addressable event containing an ordered list of music tracks.

### Format

The `.content` field SHOULD contain a Markdown track listing as a human-readable fallback:

```
# Playlist Title

Artist One - Track Title
Artist Two - Track Title

N tracks
```

The `i` tags are the canonical track references. The `.content` listing allows clients to display the playlist even when feed resolution is unavailable.

### Tags

**Required:**
- `d` - Unique identifier for this playlist
- `title` - Playlist title
- `alt` - Human-readable description (NIP-31)

**Optional:**
- `image` - URL to playlist artwork
- `i` - Track and feed references (multiple, ordered — see below)
- `t` - Category tags for discovery
- `public` - Set to `"true"` for public playlists (default)

### Example

```json
{
  "id": "<32-byte hex event id>",
  "pubkey": "<32-byte hex public key>",
  "created_at": 1700000000,
  "kind": 34139,
  "content": "# Summer Vibes 2024\n\nSurvival Guide - January Shock\nJune & The Jets - You Sure Did\nBear's Snare - Ocean Breeze\n\n3 tracks",
  "tags": [
    ["d", "summer-vibes-2024"],
    ["title", "Summer Vibes 2024"],
    ["alt", "Music playlist: Summer Vibes 2024"],
    ["t", "playlist"],
    ["t", "music"],
    ["public", "true"],
    ["image", "https://cdn.blossom.example/img/playlist.jpg"],
    ["i", "podcast:item:guid:a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
    ["i", "podcast:item:guid:b2c3d4e5-f6a7-8901-bcde-f12345678901"],
    ["i", "podcast:item:guid:c3d4e5f6-a7b8-9012-cdef-012345678902"],
    ["i", "podcast:guid:d7b4abee-1234-5678-9abc-def012345678"],
    ["i", "podcast:guid:e8c5bcff-2345-6789-abcd-ef0123456789"]
  ],
  "sig": "<64-byte hex signature>"
}
```

## Track References

Playlists reference music tracks using `i` tags with prefixes from the [Podcasting 2.0 namespace](https://github.com/Podcastindex-org/podcast-namespace):

```
["i", "podcast:item:guid:<itemGuid>"]
["i", "podcast:guid:<feedGuid>"]
```

Where:
- `podcast:item:guid` references a specific track by its RSS [`<guid>`](https://www.rssboard.org/rss-specification#hrelementsOfLtitemgt) element value. One tag per track, in playlist order.
- `podcast:guid` references the feed containing one or more tracks, by the feed's [`<podcast:guid>`](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md#guid) element value. Deduplicated — one tag per unique feed.

Item GUID tags MUST appear in playlist order. Feed GUID tags MAY appear in any order and MAY be interleaved with item tags or grouped separately.

The mapping between items and feeds is implicit. Clients resolve all feed GUIDs, parse each feed, and search across them to match each item GUID.

### Resolution

Clients resolve tracks by:

1. Collecting `podcast:guid` values from `i` tags
2. Looking up feed URLs via the Podcast Index API [`podcasts/byguid`](https://podcastindex-org.github.io/docs-api/#get-/podcasts/byguid) endpoint (requires API key + secret)
3. Fetching and parsing each feed's RSS XML
4. Matching each `podcast:item:guid` across all parsed feeds
5. Falling back to the `.content` track listing for unresolved items

### Live Example

```
naddr1qvzqqqy9tvpzpauj9g9dk0aymkj7aj4x9ahhaes4nal4tcyqxe5xc68qswpvx3ugqyt8wumn8ghj7cmgv9jxvtnwdaehgu339e3k7mgpzamhxue69uhkv6tvw3jhytnwdaehgu3wwa5kuegpzpmhxue69uhkummnw3ezuamfdejsq9tnw3skymr9ddexzen594nxzan0wf5hgetnnkkw8h
```

## Implementation Notes

- Playlists are updatable (addressable events — re-publishing with the same `d` tag replaces the previous version)
- `i` tag order is canonical; clients SHOULD preserve track order when displaying
- Clients SHOULD handle missing/deleted tracks gracefully — show a placeholder from `.content` or skip
- When a feed cannot be resolved (dead URL, removed from index), clients MAY show the corresponding `.content` line instead
- Use `naddr` identifiers to link to playlists
- Playlists support NIP-25 reactions and NIP-22 comments
- Artwork images SHOULD be hosted on Blossom servers for permanence
- Resolved feeds may contain [`<podcast:value>`](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md#value) tags — clients MAY parse these to enable Lightning payments and boosts
