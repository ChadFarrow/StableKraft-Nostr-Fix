import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parseRSSFeedWithSegments, calculateTrackOrder } from '@/lib/rss-parser-db';
import { generateAlbumSlug, normalizeUrl } from '@/lib/url-utils';

/**
 * Extract remoteItem tags from publisher feed XML
 */
function extractRemoteItemsFromXML(xml: string): Array<{ feedGuid: string; feedUrl: string }> {
  const items: Array<{ feedGuid: string; feedUrl: string }> = [];
  const regex = /<podcast:remoteItem[^>]*>/gi;
  const matches = xml.match(regex) || [];

  for (const match of matches) {
    const feedGuidMatch = match.match(/feedGuid=["']([^"']+)["']/i);
    const feedUrlMatch = match.match(/feedUrl=["']([^"]+)["']/i);
    const mediumMatch = match.match(/medium=["']([^"]+)["']/i);

    if (mediumMatch?.[1] === 'publisher') continue;

    if (feedUrlMatch?.[1]) {
      items.push({
        feedGuid: feedGuidMatch?.[1] || '',
        feedUrl: feedUrlMatch[1]
      });
    }
  }

  return items;
}

function generateFeedId(artist: string | undefined, title: string): string {
  const parts = [];
  if (artist) parts.push(generateAlbumSlug(artist));
  parts.push(generateAlbumSlug(title));
  let baseId = parts.join('-');
  if (!baseId || baseId.length < 2) baseId = `feed-${Date.now()}`;
  return baseId;
}

/**
 * POST /api/admin/publishers/import-albums
 * Import missing album feeds from all publisher feeds
 * Body: { publisherId?: string } - optional, if not provided imports for all publishers
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { publisherId } = body;

    // Get publishers to process
    const publishers = await prisma.feed.findMany({
      where: {
        type: 'publisher',
        status: 'active',
        ...(publisherId ? { id: publisherId } : {})
      },
      select: {
        id: true,
        title: true,
        artist: true,
        originalUrl: true
      }
    });

    if (publishers.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No publishers found'
      }, { status: 404 });
    }

    console.log(`🚀 Processing ${publishers.length} publisher(s) for album import`);

    const results: Array<{
      publisherId: string;
      title: string;
      remoteItems: number;
      imported: number;
      skipped: number;
      failed: number;
      errors: string[];
      skippedDetails: string[];
    }> = [];

    for (const publisher of publishers) {
      const result = {
        publisherId: publisher.id,
        title: publisher.title || publisher.id,
        remoteItems: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        errors: [] as string[],
        skippedDetails: [] as string[]
      };

      if (!publisher.originalUrl) {
        result.errors.push('No feed URL');
        results.push(result);
        continue;
      }

      try {
        console.log(`\n📋 Processing: ${publisher.title}`);

        // Fetch publisher feed
        const response = await fetch(publisher.originalUrl, {
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          result.errors.push(`HTTP ${response.status}`);
          results.push(result);
          continue;
        }

        const xml = await response.text();
        const remoteItems = extractRemoteItemsFromXML(xml);
        result.remoteItems = remoteItems.length;

        console.log(`   Found ${remoteItems.length} album references`);

        // Import each album
        for (const item of remoteItems) {
          if (!item.feedUrl) {
            result.skippedDetails.push('no-feedUrl');
            result.skipped++;
            continue;
          }

          try {
            // Check if exists
            const conditions: any[] = [{ originalUrl: item.feedUrl }];
            if (item.feedGuid) {
              conditions.push({ id: item.feedGuid });
              conditions.push({ guid: item.feedGuid });
              conditions.push({ originalUrl: { contains: item.feedGuid } });
            }

            const existing = await prisma.feed.findFirst({
              where: { OR: conditions }
            });

            if (existing) {
              console.log(`   ⏭️ Skipping (exists): ${existing.title} (${existing.id})`);
              result.skippedDetails.push(`exists:${existing.id}|${existing.title}|pubId:${existing.publisherId}`);
              if (!existing.publisherId) {
                await prisma.feed.update({
                  where: { id: existing.id },
                  data: { publisherId: publisher.id }
                });
                console.log(`   🔗 Linked to publisher: ${publisher.id}`);
              }
              result.skipped++;
              continue;
            }

            // Parse and import
            const parsedFeed = await parseRSSFeedWithSegments(item.feedUrl);

            let feedId = generateFeedId(parsedFeed.artist, parsedFeed.title);
            const idExists = await prisma.feed.findUnique({ where: { id: feedId } });
            if (idExists) feedId = `${feedId}-${Date.now()}`;

            if (parsedFeed.podcastGuid) {
              const guidExists = await prisma.feed.findFirst({
                where: { guid: parsedFeed.podcastGuid }
              });
              if (guidExists) {
                result.skippedDetails.push(`guid:${guidExists.id}|${guidExists.title}|pubId:${guidExists.publisherId}`);
                if (!guidExists.publisherId) {
                  await prisma.feed.update({
                    where: { id: guidExists.id },
                    data: { publisherId: publisher.id }
                  });
                }
                result.skipped++;
                continue;
              }
            }

            // Create feed
            const feed = await prisma.feed.create({
              data: {
                id: feedId,
                guid: parsedFeed.podcastGuid || null,
                originalUrl: normalizeUrl(item.feedUrl),
                cdnUrl: normalizeUrl(item.feedUrl),
                type: 'album',
                priority: 'normal',
                title: parsedFeed.title,
                description: parsedFeed.description,
                artist: parsedFeed.artist,
                image: parsedFeed.image,
                language: parsedFeed.language,
                category: parsedFeed.category,
                podcastCategories: parsedFeed.podcastCategories || [],
                explicit: parsedFeed.explicit,
                v4vRecipient: parsedFeed.v4vRecipient || null,
                v4vValue: parsedFeed.v4vValue || null,
                publisherId: publisher.id,
                lastFetched: new Date(),
                status: 'active',
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });

            // Create tracks
            if (parsedFeed.items.length > 0) {
              const tracksData = parsedFeed.items.map((track, index) => ({
                id: `${feed.id}-${track.guid || `track-${index}-${Date.now()}`}`,
                feedId: feed.id,
                guid: track.guid,
                title: track.title,
                subtitle: track.subtitle,
                description: track.description,
                artist: track.artist,
                audioUrl: track.audioUrl,
                duration: track.duration,
                explicit: track.explicit,
                image: track.image,
                publishedAt: track.publishedAt,
                itunesAuthor: track.itunesAuthor,
                itunesSummary: track.itunesSummary,
                itunesImage: track.itunesImage,
                itunesDuration: track.itunesDuration,
                itunesKeywords: track.itunesKeywords || [],
                itunesCategories: track.itunesCategories || [],
                podcastCategories: parsedFeed.podcastCategories || [],
                v4vRecipient: track.v4vRecipient,
                v4vValue: track.v4vValue,
                startTime: track.startTime,
                endTime: track.endTime,
                trackOrder: track.episode ? calculateTrackOrder(track.episode, track.season) : index + 1,
                updatedAt: new Date()
              }));

              await prisma.track.createMany({
                data: tracksData,
                skipDuplicates: true
              });
            }

            console.log(`   ✅ ${parsedFeed.title} (${parsedFeed.items.length} tracks)`);
            result.imported++;

            await new Promise(r => setTimeout(r, 100));
          } catch (error) {
            result.failed++;
            result.errors.push(`${item.feedUrl}: ${error instanceof Error ? error.message : 'Unknown'}`);
          }
        }

        // Also link by artist name
        const artistName = publisher.artist || publisher.title;
        if (artistName) {
          await prisma.feed.updateMany({
            where: {
              artist: { equals: artistName, mode: 'insensitive' },
              type: { in: ['album', 'music'] },
              publisherId: null
            },
            data: { publisherId: publisher.id }
          });
        }

      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : 'Unknown error');
      }

      results.push(result);
    }

    const totals = {
      publishers: results.length,
      imported: results.reduce((s, r) => s + r.imported, 0),
      skipped: results.reduce((s, r) => s + r.skipped, 0),
      failed: results.reduce((s, r) => s + r.failed, 0)
    };

    console.log(`\n✅ Complete: ${totals.imported} imported, ${totals.skipped} skipped, ${totals.failed} failed`);

    return NextResponse.json({
      success: true,
      message: `Processed ${totals.publishers} publishers: ${totals.imported} albums imported`,
      totals,
      results
    });

  } catch (error) {
    console.error('Error importing publisher albums:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
