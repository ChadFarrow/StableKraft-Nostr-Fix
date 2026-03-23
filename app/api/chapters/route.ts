import { NextRequest, NextResponse } from 'next/server';

export interface Chapter {
  title: string;
  startTime: number;
  endTime?: number;
  url?: string;
  img?: string;
  image?: string;
  toc?: boolean;
}

interface ChaptersResponse {
  version: string;
  chapters: Chapter[];
}

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

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
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

    const data: ChaptersResponse = await response.json();

    if (!data.chapters || !Array.isArray(data.chapters)) {
      return NextResponse.json({ error: 'Invalid chapters format' }, { status: 502 });
    }

    // Filter out toc:false chapters, sort by startTime, chain endTimes
    const chapters = data.chapters
      .filter(ch => ch.toc !== false)
      .sort((a, b) => a.startTime - b.startTime)
      .map((ch, i, arr) => ({
        title: ch.title,
        startTime: ch.startTime,
        endTime: ch.endTime ?? arr[i + 1]?.startTime ?? undefined,
        img: ch.img || ch.image || undefined,
      }));

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
