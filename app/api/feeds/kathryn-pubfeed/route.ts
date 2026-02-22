import { NextResponse } from 'next/server';

// Kathryn's album feeds across all platforms
const kathrynAlbums = [
  // RSS Blue albums
  { feedGuid: '27bc3c57-6b47-5029-873d-9876c7ba2f1e', feedUrl: 'https://feeds.rssblue.com/lemons', title: 'Lemons' },
  { feedGuid: '60815bd3-adbd-5800-a127-3512ccae14a7', feedUrl: 'https://feeds.rssblue.com/socrates', title: 'Socrates' },
  // Fountain.fm albums
  { feedGuid: 'b2c1f762-1f54-5a71-aeb0-b3a041a85f8d', feedUrl: 'https://feeds.fountain.fm/DsIzE8JF79ZiGmlen8uC', title: 'Scoot' },
];

export async function GET() {
  try {
    const publisherFeedGuid = 'kathryn-publisher-stablekraft';
    const currentDate = new Date().toUTCString();

    const remoteItems = kathrynAlbums
      .map(album => `    <podcast:remoteItem medium="music" feedGuid="${album.feedGuid}" feedUrl="${album.feedUrl}" />`)
      .join('\n');

    const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title><![CDATA[Kathryn]]></title>
    <description><![CDATA[Singer-songwriter based in Nashville. Moody, sultry, bluesy, Belmonty...]]></description>
    <generator>StableKraft</generator>
    <lastBuildDate>${currentDate}</lastBuildDate>
    <atom:link href="https://stablekraft.app/api/feeds/kathryn-pubfeed" rel="self" type="application/rss+xml" />

    <podcast:medium>publisher</podcast:medium>
    <podcast:guid>${publisherFeedGuid}</podcast:guid>

    <podcast:person role="artist">Kathryn</podcast:person>

${remoteItems}

    <itunes:summary>Singer-songwriter based in Nashville. Moody, sultry, bluesy, Belmonty...</itunes:summary>
    <itunes:author>Kathryn</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:image href="https://media.rssblue.com/podcasts/lemons/cover-art.kathryn-lemons.jpg"/>
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
    console.error('Error generating Kathryn publisher feed:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
