'use client';

import { useState } from 'react';
import { Globe } from 'lucide-react';
import { useNostr } from '@/contexts/NostrContext';
import PublishPlaylistModal from './PublishPlaylistModal';
import { PlaylistTrack } from '@/lib/nostr/playlist-events';

interface PublishPlaylistButtonProps {
  tracks: PlaylistTrack[];
}

export default function PublishPlaylistButton({ tracks }: PublishPlaylistButtonProps) {
  const { user, isAuthenticated } = useNostr();
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Hide when not authenticated, NIP-05 login, or no tracks
  const isNip05Login = user?.loginType === 'nip05';
  if (!isAuthenticated || isNip05Login || tracks.length === 0) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-500 to-indigo-500 hover:from-purple-600 hover:to-indigo-600 text-white rounded-lg text-sm font-medium transition-all"
        title="Publish favorites as a Nostr playlist"
      >
        <Globe className="w-4 h-4" />
        <span>Share to Nostr</span>
      </button>

      <PublishPlaylistModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        tracks={tracks}
      />
    </>
  );
}
