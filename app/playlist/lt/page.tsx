'use client';

import PlaylistTemplateCompact from '@/components/PlaylistTemplateCompact';
import { PlaylistConfig } from '@/types/playlist';

const ltConfig: PlaylistConfig = {
  title: 'Lightning Thrashes Music Playlist',
  description: 'Curated playlist from Lightning Thrashes featuring Value4Value independent artists',
  apiEndpoint: '/api/playlist/lt-fast',
  cacheKey: 'lt-playlist-v1',
  cacheDuration: 1000 * 60 * 30, // 30 minutes
  useAudioContext: true
};

export default function LTPlaylistPage() {
  return <PlaylistTemplateCompact config={ltConfig} />;
}
