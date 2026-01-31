/**
 * One-time DB cleanup: clear publisherId from feeds that were linked from
 * <podcast:podroll> before the fix. Only feeds that appear in the publisher
 * feed outside the podroll section should keep publisherId.
 *
 * Run: npx tsx scripts/clear-podroll-publisher-links.ts [publisherId]
 * - No args: process all active publisher feeds
 * - publisherId: process only that publisher
 * - --dry-run: log what would be cleared without updating DB
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Extract "official" remoteItem GUIDs and URLs from publisher feed XML
 * (same logic as publisher page / link-albums: strip podroll first, then
 * only include music/album items, skip publisher refs and -pubfeed.xml / feed.xml)
 */
function extractOfficialRemoteItems(xml: string): { guids: Set<string>; urls: Set<string> } {
  const guids = new Set<string>();
  const urls = new Set<string>();

  const xmlWithoutPodroll = xml.replace(/<podcast:podroll>[\s\S]*?<\/podcast:podroll>/gi, '');
  const remoteItemRegex = /<podcast:remoteItem[^>]*>/g;
  const matches = xmlWithoutPodroll.match(remoteItemRegex) || [];

  for (const match of matches) {
    const feedGuidMatch = match.match(/feedGuid="([^"]+)"/);
    const feedUrlMatch = match.match(/feedUrl="([^"]+)"/);
    const mediumMatch = match.match(/medium="([^"]+)"/);

    const medium = (mediumMatch?.[1] || 'music').toLowerCase();

    if (medium === 'publisher') continue;

    if (feedUrlMatch?.[1]) {
      const url = feedUrlMatch[1].toLowerCase();
      if (url.includes('-pubfeed.xml') || url.endsWith('/feed.xml')) continue;
    }

    if (feedGuidMatch?.[1]) guids.add(feedGuidMatch[1]);
    if (feedUrlMatch?.[1]) urls.add(feedUrlMatch[1]);
  }

  return { guids, urls };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const publisherIdArg = args[0];

  console.log(DRY_RUN ? '🔍 Dry run – no DB updates\n' : '🧹 Clearing podroll-sourced publisherId links\n');

  const publishers = await prisma.feed.findMany({
    where: {
      type: 'publisher',
      status: 'active',
      ...(publisherIdArg ? { id: publisherIdArg } : {}),
    },
    select: { id: true, title: true, originalUrl: true },
    orderBy: { title: 'asc' },
  });

  if (publishers.length === 0) {
    console.log('No publishers found.');
    process.exit(0);
  }

  let totalCleared = 0;

  for (const publisher of publishers) {
    if (!publisher.originalUrl?.trim()) {
      console.log(`⏭️ Skip "${publisher.title}" (no feed URL)`);
      continue;
    }

    let xmlText: string;
    try {
      const res = await fetch(publisher.originalUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        console.log(`⏭️ Skip "${publisher.title}" – fetch failed: ${res.status}`);
        continue;
      }
      xmlText = await res.text();
    } catch (e) {
      console.log(`⏭️ Skip "${publisher.title}" – fetch error:`, e instanceof Error ? e.message : e);
      continue;
    }

    const { guids, urls } = extractOfficialRemoteItems(xmlText);

    const linkedFeeds = await prisma.feed.findMany({
      where: {
        publisherId: publisher.id,
        type: { in: ['album', 'music'] },
      },
      select: { id: true, title: true, originalUrl: true },
    });

    const toClear = linkedFeeds.filter((f) => {
      const byGuid = guids.has(f.id);
      const byUrl = f.originalUrl && urls.has(f.originalUrl);
      return !byGuid && !byUrl;
    });

    if (toClear.length === 0) {
      console.log(`✅ ${publisher.title}: no podroll-only links to clear`);
      continue;
    }

    console.log(`📋 ${publisher.title}: clearing publisherId from ${toClear.length} feed(s) (podroll-only)`);
    toClear.forEach((f) => console.log(`   - ${f.title} (${f.id})`));

    if (!DRY_RUN && toClear.length > 0) {
      const result = await prisma.feed.updateMany({
        where: { id: { in: toClear.map((f) => f.id) } },
        data: { publisherId: null },
      });
      totalCleared += result.count;
    } else if (DRY_RUN) {
      totalCleared += toClear.length;
    }
  }

  console.log(DRY_RUN ? `\nWould clear publisherId from ${totalCleared} feed(s).` : `\nCleared publisherId from ${totalCleared} feed(s).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
