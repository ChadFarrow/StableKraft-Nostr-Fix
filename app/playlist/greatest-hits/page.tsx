'use client';

import PlaylistTemplateCompact from '@/components/PlaylistTemplateCompact';
import { PlaylistConfig } from '@/types/playlist';

const greatestHitsConfig: PlaylistConfig = {
  title: "ChadF's Greatest Hits Music Playlist",
  description: 'Most frequently played tracks across all ChadF musicL playlists - songs appearing 2+ times, organized by play count',
  apiEndpoint: '/api/playlist/greatest-hits-fast',
  cacheKey: 'greatestHits-playlist-v1',
  cacheDuration: 1000 * 60 * 30, // 30 minutes
  useAudioContext: true
};

export default function GreatestHitsPlaylistPage() {
  return <PlaylistTemplateCompact config={greatestHitsConfig} />;
}
