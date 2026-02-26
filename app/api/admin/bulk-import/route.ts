import { NextRequest, NextResponse } from 'next/server';
import { parsePodcastIndexSearchUrl, searchPodcastIndex, type PodcastIndexFeed } from '@/lib/podcast-index-api';
import { prisma } from '@/lib/prisma';
import { normalizeUrl } from '@/lib/url-utils';
import { isBlacklistedFeedId, isBlacklistedFeedUrl } from '@/lib/feed-exclusions';

/**
 * GET /api/admin/bulk-import?url=<podcastindex search URL>
 *
 * Parses a Podcast Index search URL, calls the PI API, and returns
 * a preview list of feeds that can be imported.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
      return NextResponse.json({ error: 'url parameter is required' }, { status: 400 });
    }

    // Parse the PI search URL
    const searchParams2 = parsePodcastIndexSearchUrl(url);
    if (!searchParams2) {
      return NextResponse.json(
        { error: 'Not a valid Podcast Index search URL. Expected format: https://podcastindex.org/search?q=...' },
        { status: 400 }
      );
    }

    // Map PI website type to API medium parameter
    const medium = searchParams2.type === 'music' ? 'music' : undefined;

    // Search PI API
    const feeds = await searchPodcastIndex(searchParams2.query, medium, 100);

    if (feeds.length === 0) {
      return NextResponse.json({
        query: searchParams2.query,
        type: searchParams2.type,
        feeds: [],
        message: 'No feeds found for this search'
      });
    }

    // Check which feeds already exist in our DB
    const feedUrls = feeds.map(f => normalizeUrl(f.url || f.originalUrl));
    const existingFeeds = await prisma.feed.findMany({
      where: {
        originalUrl: { in: feedUrls }
      },
      select: { originalUrl: true, id: true, title: true }
    });
    const existingUrlSet = new Set(existingFeeds.map(f => f.originalUrl));

    // Also check by GUID for feeds that might have different URLs
    const feedGuids = feeds
      .map(f => {
        // PI API doesn't always have podcastGuid directly, but the chash or id can help
        // We'll check by URL primarily
        return null;
      })
      .filter(Boolean);

    // Build preview results
    const previewFeeds = feeds.map(feed => {
      const feedUrl = feed.url || feed.originalUrl;
      const normalizedFeedUrl = normalizeUrl(feedUrl);
      const alreadyExists = existingUrlSet.has(normalizedFeedUrl);
      const isBlacklisted = isBlacklistedFeedUrl(feedUrl);

      return {
        piId: feed.id,
        title: feed.title,
        author: feed.author || feed.ownerName,
        image: feed.artwork || feed.image,
        feedUrl,
        medium: feed.medium,
        episodeCount: feed.episodeCount,
        alreadyExists,
        isBlacklisted,
        existingFeedId: alreadyExists
          ? existingFeeds.find(e => e.originalUrl === normalizedFeedUrl)?.id
          : undefined,
      };
    });

    // Sort: new feeds first, then existing
    previewFeeds.sort((a, b) => {
      if (a.isBlacklisted !== b.isBlacklisted) return a.isBlacklisted ? 1 : -1;
      if (a.alreadyExists !== b.alreadyExists) return a.alreadyExists ? 1 : -1;
      return 0;
    });

    return NextResponse.json({
      query: searchParams2.query,
      type: searchParams2.type,
      totalFound: feeds.length,
      newFeeds: previewFeeds.filter(f => !f.alreadyExists && !f.isBlacklisted).length,
      existingFeeds: previewFeeds.filter(f => f.alreadyExists).length,
      blacklistedFeeds: previewFeeds.filter(f => f.isBlacklisted).length,
      feeds: previewFeeds,
    });
  } catch (error) {
    console.error('Error in bulk import preview:', error);
    return NextResponse.json(
      { error: 'Failed to search Podcast Index' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/bulk-import
 * Body: { feedUrls: string[], type?: string }
 *
 * Imports multiple feeds sequentially using SSE streaming for progress updates.
 * Each feed is imported via the same logic as POST /api/feeds.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { feedUrls, type = 'album' } = body;

    if (!feedUrls || !Array.isArray(feedUrls) || feedUrls.length === 0) {
      return NextResponse.json({ error: 'feedUrls array is required' }, { status: 400 });
    }

    // Limit to 100 feeds per batch
    if (feedUrls.length > 100) {
      return NextResponse.json({ error: 'Maximum 100 feeds per batch' }, { status: 400 });
    }

    // Use SSE streaming for progress
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: any) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        send({
          type: 'start',
          total: feedUrls.length,
        });

        let imported = 0;
        let skipped = 0;
        let failed = 0;
        const results: Array<{
          feedUrl: string;
          status: 'imported' | 'skipped' | 'failed';
          title?: string;
          artist?: string;
          trackCount?: number;
          feedId?: string;
          error?: string;
        }> = [];

        for (let i = 0; i < feedUrls.length; i++) {
          const feedUrl = feedUrls[i];

          try {
            // Check blacklist
            if (isBlacklistedFeedUrl(feedUrl)) {
              skipped++;
              results.push({ feedUrl, status: 'skipped', error: 'Blacklisted' });
              send({
                type: 'progress',
                current: i + 1,
                total: feedUrls.length,
                feedUrl,
                status: 'skipped',
                reason: 'blacklisted',
                imported,
                skipped,
                failed,
              });
              continue;
            }

            // Check if already exists
            const normalizedUrl = normalizeUrl(feedUrl);
            const existing = await prisma.feed.findUnique({
              where: { originalUrl: normalizedUrl },
              select: { id: true, title: true }
            });

            if (existing) {
              skipped++;
              results.push({ feedUrl, status: 'skipped', title: existing.title, feedId: existing.id });
              send({
                type: 'progress',
                current: i + 1,
                total: feedUrls.length,
                feedUrl,
                status: 'skipped',
                reason: 'exists',
                title: existing.title,
                feedId: existing.id,
                imported,
                skipped,
                failed,
              });
              continue;
            }

            // Import feed via internal API call
            // We call our own /api/feeds endpoint to reuse all the parsing, dedup, publisher detection logic
            const baseUrl = request.nextUrl.origin;
            const importResponse = await fetch(`${baseUrl}/api/feeds`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                originalUrl: feedUrl,
                type,
                priority: 'normal',
              }),
            });

            const importData = await importResponse.json();

            if (importResponse.ok || importResponse.status === 206) {
              imported++;
              const feedTitle = importData.feed?.title || 'Unknown';
              const feedArtist = importData.feed?.artist || '';
              const trackCount = importData.feed?._count?.Track || 0;
              const feedId = importData.feed?.id || '';

              results.push({
                feedUrl,
                status: 'imported',
                title: feedTitle,
                artist: feedArtist,
                trackCount,
                feedId,
              });

              send({
                type: 'progress',
                current: i + 1,
                total: feedUrls.length,
                feedUrl,
                status: 'imported',
                title: feedTitle,
                artist: feedArtist,
                trackCount,
                feedId,
                imported,
                skipped,
                failed,
              });
            } else if (importResponse.status === 409) {
              // Feed already exists (race condition or URL encoding difference)
              skipped++;
              results.push({
                feedUrl,
                status: 'skipped',
                title: importData.feed?.title,
                feedId: importData.feed?.id,
              });

              send({
                type: 'progress',
                current: i + 1,
                total: feedUrls.length,
                feedUrl,
                status: 'skipped',
                reason: 'exists',
                title: importData.feed?.title,
                imported,
                skipped,
                failed,
              });
            } else {
              failed++;
              results.push({ feedUrl, status: 'failed', error: importData.error || 'Import failed' });

              send({
                type: 'progress',
                current: i + 1,
                total: feedUrls.length,
                feedUrl,
                status: 'failed',
                error: importData.error || 'Import failed',
                imported,
                skipped,
                failed,
              });
            }

            // Small delay between imports to avoid overwhelming servers
            if (i < feedUrls.length - 1) {
              await new Promise(r => setTimeout(r, 300));
            }
          } catch (error) {
            failed++;
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            results.push({ feedUrl, status: 'failed', error: errorMsg });

            send({
              type: 'progress',
              current: i + 1,
              total: feedUrls.length,
              feedUrl,
              status: 'failed',
              error: errorMsg,
              imported,
              skipped,
              failed,
            });
          }
        }

        send({
          type: 'complete',
          imported,
          skipped,
          failed,
          total: feedUrls.length,
          results,
        });

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return NextResponse.json(
      { error: 'Failed to start bulk import' },
      { status: 500 }
    );
  }
}
