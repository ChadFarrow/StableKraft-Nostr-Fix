import { NextResponse } from 'next/server';

// CityBeach's album feeds across all platforms
const citybeachAlbums = [
  // Self-hosted on sirtjthewrathful.com
  { feedGuid: '5bb8f186-2460-54dc-911d-54f642e8adf6', feedUrl: 'https://www.sirtjthewrathful.com/wp-content/uploads/2023/08/CityBeach.xml', title: 'CityBeach' },
  { feedGuid: '1e7ed1fa-0456-5860-9b34-825d1335d8f8', feedUrl: 'https://www.sirtjthewrathful.com/wp-content/uploads/2023/08/Nostalgic.xml', title: 'Nostalgic' },
  // Self-hosted on doerfelverse.com
  { feedGuid: '47768d25-74d9-5ba4-82db-aeaa7f50e29c', feedUrl: 'https://www.doerfelverse.com/feeds/autumn.xml', title: 'Autumn' },
  { feedGuid: 'b84c3345-55db-54e0-ac41-4b1cc6f3df67', feedUrl: 'https://www.doerfelverse.com/feeds/pour-over.xml', title: 'Pour Over' },
  { feedGuid: 'a40615ac-1b3c-5c76-8961-6bbc86e20439', feedUrl: 'https://www.doerfelverse.com/feeds/alandace.xml', title: 'Alandace' },
  { feedGuid: 'a3d6d7d5-4b5d-5161-b119-cf5e99d35fda', feedUrl: 'https://www.doerfelverse.com/feeds/first-married-christmas.xml', title: 'First Married Christmas' },
];

export async function GET() {
  try {
    const publisherFeedGuid = 'citybeach-publisher-stablekraft';
    const currentDate = new Date().toUTCString();

    const remoteItems = citybeachAlbums
      .map(album => `    <podcast:remoteItem medium="music" feedGuid="${album.feedGuid}" feedUrl="${album.feedUrl}" />`)
      .join('\n');

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title><![CDATA[CityBeach]]></title>
    <description><![CDATA[CityBeach - Original music across multiple genres.]]></description>
    <generator>StableKraft</generator>
    <lastBuildDate>${currentDate}</lastBuildDate>
    <atom:link href="https://stablekraft.app/api/feeds/citybeach-pubfeed" rel="self" type="application/rss+xml" />

    <podcast:medium>publisher</podcast:medium>
    <podcast:guid>${publisherFeedGuid}</podcast:guid>

    <podcast:person role="artist">CityBeach</podcast:person>

${remoteItems}

    <itunes:summary>CityBeach - Original music across multiple genres.</itunes:summary>
    <itunes:author>CityBeach</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:image href="https://www.doerfelverse.com/art/citybeach.png"/>
    <itunes:category text="Music" />
  </channel>
</rss>`;

    return new NextResponse(feedXml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Error generating CityBeach publisher feed:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
