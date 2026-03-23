import { NextRequest, NextResponse } from 'next/server';
import { parseChaptersJSON } from '@/lib/rss-parser-db';

/**
 * GET /api/chapters?url=<chaptersUrl>
 * Proxies podcast chapter JSON files to avoid CORS issues on the client.
 * Returns parsed and sorted chapters array.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  // URL validation + SSRF protection
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only HTTPS URLs are allowed' }, { status: 400 });
  }

  // Block private/internal hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    hostname === '0.0.0.0'
  ) {
    return NextResponse.json({ error: 'Private URLs are not allowed' }, { status: 400 });
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'StableKraft/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch chapters: ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const chapters = parseChaptersJSON(data);

    if (!chapters) {
      return NextResponse.json({ error: 'Invalid chapters format' }, { status: 502 });
    }

    return NextResponse.json(
      { chapters },
      {
        headers: {
          'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        },
      }
    );
  } catch (error) {
    console.error('Error fetching chapters:', error);
    return NextResponse.json(
      { error: 'Failed to fetch chapters' },
      { status: 500 }
    );
  }
}
