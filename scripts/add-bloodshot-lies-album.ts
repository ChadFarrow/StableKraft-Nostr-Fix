#!/usr/bin/env ts-node

/**
 * Add "Bloodshot Lies - The Album" by The Doerfels to the database.
 *
 * Used for testing BoostBox messages / Nostr boost signing end-to-end.
 * The feed has a channel-level <podcast:value> block with real Lightning
 * recipients, which is what BoostBox needs to render payment metadata.
 *
 * Run: npx ts-node scripts/add-bloodshot-lies-album.ts
 */

import { PrismaClient } from '@prisma/client';
import Parser from 'rss-parser';
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

const prisma = new PrismaClient();

const FEED_URL = 'https://www.doerfelverse.com/feeds/bloodshot-lies-album.xml';
const FEED_GUID = '5a95f9d8-35e3-51f5-a269-ba1df36b4bd8';
const FEED_ID = `doerfels-${FEED_GUID.substring(0, 8)}`;

class PodcastParser extends Parser {
  constructor() {
    super({
      customFields: {
        item: [
          ['enclosure', 'enclosure'],
          ['itunes:duration', 'duration'],
          ['itunes:image', 'image'],
          ['itunes:explicit', 'explicit'],
          ['content:encoded', 'contentEncoded'],
          ['podcast:guid', 'podcastGuid'],
        ],
      },
    });
  }
}

interface V4VRecipient {
  name?: string;
  type?: string;
  address?: string;
  split: number;
  customKey?: string;
  customValue?: string;
  fee?: boolean;
}

interface V4VBlock {
  type: string;
  method: string;
  suggested?: string;
  recipients: V4VRecipient[];
}

async function parseChannelV4V(xml: string): Promise<V4VBlock | null> {
  const parsed = await parseStringPromise(xml);
  const channel = parsed.rss?.channel?.[0];
  const value = channel?.['podcast:value']?.[0];
  if (!value?.['podcast:valueRecipient']) return null;

  return {
    type: value.$?.type || 'lightning',
    method: value.$?.method || 'keysend',
    suggested: value.$?.suggested,
    recipients: value['podcast:valueRecipient'].map((r: any) => ({
      name: r.$?.name,
      type: r.$?.type,
      address: r.$?.address,
      split: parseInt(r.$?.split || '0', 10),
      customKey: r.$?.customKey,
      customValue: r.$?.customValue,
      fee: r.$?.fee === 'true',
    })),
  };
}

function durationToSeconds(raw: unknown): number {
  if (!raw) return 0;
  const parts = String(raw).split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.isFinite(parts[0]) ? parts[0] : 0;
}

function pickImageUrl(maybe: unknown, fallback: string): string {
  if (!maybe) return fallback;
  if (typeof maybe === 'string') return maybe;
  if (typeof maybe === 'object') {
    const m = maybe as any;
    return m.url || m.href || m.$?.href || m.$?.url || fallback;
  }
  return fallback;
}

async function main() {
  console.log('Adding Bloodshot Lies - The Album (The Doerfels)');
  console.log('='.repeat(70));

  const existing = await prisma.feed.findFirst({
    where: {
      OR: [{ originalUrl: FEED_URL }, { guid: FEED_GUID }, { id: FEED_ID }],
    },
  });

  if (existing) {
    console.log(`Already in DB as id=${existing.id} ("${existing.title}") - nothing to do.`);
    return;
  }

  console.log(`Fetching ${FEED_URL}`);
  const response = await fetch(FEED_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching feed`);
  }
  const xml = await response.text();

  const parser = new PodcastParser();
  const feed = await parser.parseString(xml);
  if (!feed?.items?.length) {
    throw new Error('Feed has no items');
  }

  const v4v = await parseChannelV4V(xml);
  const primaryRecipient = v4v?.recipients.find((r) => r.split > 0)?.address ?? null;

  const albumTitle = feed.title || 'Bloodshot Lies - The Album';
  const artist = feed.itunes?.author || 'The Doerfels';
  const description = feed.description || '';
  const coverArt = pickImageUrl(feed.itunes?.image, '') || pickImageUrl(feed.image, '') || '';

  console.log(`Parsed "${albumTitle}" by ${artist} — ${feed.items.length} tracks`);
  console.log(`V4V recipients: ${v4v?.recipients.length ?? 0}, primary: ${primaryRecipient ?? '(none)'}`);

  const tracksData = feed.items.map((item: any, index: number) => {
    const trackGuid = item.podcastGuid || item.guid || `${FEED_GUID}-track-${index + 1}`;
    return {
      id: `${FEED_ID}-${trackGuid}`,
      guid: trackGuid,
      title: item.title || `Track ${index + 1}`,
      description: item.contentEncoded || item.description || '',
      audioUrl: item.enclosure?.url || '',
      duration: durationToSeconds(item.duration || item.itunes?.duration),
      image: pickImageUrl(item.image, coverArt),
      explicit: item.explicit === 'yes' || item.itunes?.explicit === 'yes',
      artist,
      album: albumTitle,
      trackOrder: index + 1,
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      updatedAt: new Date(),
      v4vRecipient: primaryRecipient,
      v4vValue: v4v ? (v4v as any) : undefined,
    };
  });

  await prisma.feed.create({
    data: {
      id: FEED_ID,
      guid: FEED_GUID,
      originalUrl: FEED_URL,
      title: albumTitle,
      description,
      type: 'album',
      status: 'active',
      artist,
      image: coverArt,
      explicit: feed.itunes?.explicit === 'yes',
      priority: 'normal',
      v4vRecipient: primaryRecipient,
      v4vValue: v4v ? (v4v as any) : undefined,
      updatedAt: new Date(),
      Track: { create: tracksData },
    },
  });

  console.log(`Added feed id=${FEED_ID} with ${tracksData.length} tracks.`);
}

main()
  .catch((err) => {
    console.error('Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
