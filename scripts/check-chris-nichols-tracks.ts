/**
 * Check track status for Chris Nichols albums
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkTracks() {
  // Get all Chris Nichols albums
  const albums = await prisma.feed.findMany({
    where: { publisherId: 'chris-nichols' },
    select: {
      id: true,
      title: true,
      Track: {
        select: {
          id: true,
          title: true,
          audioUrl: true
        }
      }
    }
  });

  console.log('Chris Nichols albums track status:');
  console.log('='.repeat(80));

  let withValidTracks = 0;
  let withEmptyTracks = 0;
  let noTracks = 0;
  const problemAlbums: string[] = [];

  for (const album of albums) {
    const validTracks = album.Track.filter(t => t.audioUrl && t.audioUrl.trim() !== '').length;
    const emptyTracks = album.Track.filter(t => !t.audioUrl || t.audioUrl.trim() === '').length;
    const totalTracks = album.Track.length;

    let status = '';
    if (totalTracks === 0) {
      noTracks++;
      status = '❌ NO TRACKS';
      problemAlbums.push(album.id);
    } else if (validTracks === 0) {
      withEmptyTracks++;
      status = '⚠️ ALL EMPTY audioUrl';
      problemAlbums.push(album.id);
    } else {
      withValidTracks++;
      status = '✅ OK';
    }

    console.log(`${status} ${album.title || album.id}`);
    console.log(`   Total: ${totalTracks}, Valid: ${validTracks}, Empty: ${emptyTracks}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log(`SUMMARY: ${albums.length} total albums`);
  console.log(`✅ With valid tracks: ${withValidTracks}`);
  console.log(`⚠️ All empty audioUrl: ${withEmptyTracks}`);
  console.log(`❌ No tracks at all: ${noTracks}`);

  if (problemAlbums.length > 0) {
    console.log('\nProblem album IDs (need reparse):');
    problemAlbums.forEach(id => console.log(`  - ${id}`));
  }

  await prisma.$disconnect();
}

checkTracks().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
