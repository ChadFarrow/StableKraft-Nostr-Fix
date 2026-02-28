'use client';

import PlaylistTemplateCompact from '@/components/PlaylistTemplateCompact';
import { PlaylistConfig } from '@/types/playlist';

const tftConfig: PlaylistConfig = {
  title: 'Two for Tunestr Music Playlist',
  description: 'Every music reference from Two for Tunestr',
  apiEndpoint: '/api/playlist/tft-fast',
  cacheKey: 'tft-playlist-v1',
  cacheDuration: 1000 * 60 * 30, // 30 minutes
  useAudioContext: true
};

export default function TFTPlaylistPage() {
  return <PlaylistTemplateCompact config={tftConfig} />;
}
