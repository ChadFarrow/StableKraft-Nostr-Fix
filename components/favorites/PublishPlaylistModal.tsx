'use client';

import { useState } from 'react';
import { X, Check, Copy, AlertCircle, Loader2 } from 'lucide-react';
import { useNostr } from '@/contexts/NostrContext';
import { publishPlaylistToNostr, PlaylistTrack } from '@/lib/nostr/playlist-events';

interface PublishPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  tracks: PlaylistTrack[];
}

type ModalState = 'form' | 'publishing' | 'success' | 'error';

export default function PublishPlaylistModal({ isOpen, onClose, tracks }: PublishPlaylistModalProps) {
  const { user } = useNostr();
  const displayName = user?.displayName;
  const title = displayName ? `${displayName}'s Favorite Tracks` : 'My Favorite Tracks';
  const [state, setState] = useState<ModalState>('form');
  const [naddr, setNaddr] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handlePublish = async () => {
    setState('publishing');

    const userRelays = user?.relays && user.relays.length > 0 ? user.relays : undefined;
    const result = await publishPlaylistToNostr(title, tracks, userRelays);

    if (result.success && result.naddr) {
      setNaddr(result.naddr);
      setState('success');
    } else {
      setErrorMessage(result.error || 'Failed to publish playlist');
      setState('error');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(naddr);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for iOS
      const textarea = document.createElement('textarea');
      textarea.value = naddr;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setState('form');
    setNaddr('');
    setErrorMessage('');
    setCopied(false);
    onClose();
  };

  const handleRetry = () => {
    setErrorMessage('');
    setState('form');
  };

  // Preview tracks (first 10)
  const previewTracks = tracks.slice(0, 10);
  const tracksWithGuids = tracks.filter(t => t.guid).length;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-xl max-w-md w-full p-6 relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Pre-publish form */}
        {state === 'form' && (
          <>
            <h2 className="text-xl font-bold text-white mb-4">
              Publish Playlist to Nostr
            </h2>

            <div className="mb-4 p-3 bg-gray-800 rounded-lg">
              <p className="text-sm text-gray-400">Playlist Title</p>
              <p className="text-white font-semibold">{title}</p>
            </div>

            <div className="mb-4 p-3 bg-gray-800 rounded-lg">
              <p className="text-sm text-gray-400 mb-2">
                {tracks.length} tracks ({tracksWithGuids} with Podcast Index GUIDs)
              </p>
              <div className="space-y-1">
                {previewTracks.map((track, i) => (
                  <p key={i} className="text-xs text-gray-300 truncate">
                    {track.artist || track.Feed?.artist || 'Unknown'} - {track.title}
                  </p>
                ))}
                {tracks.length > 10 && (
                  <p className="text-xs text-gray-500">
                    ...and {tracks.length - 10} more
                  </p>
                )}
              </div>
            </div>

            <p className="text-xs text-gray-500 mb-4">
              Publishes as a kind 34139 addressable event. Re-publishing replaces the previous version.
            </p>

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handlePublish}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Publish
              </button>
            </div>
          </>
        )}

        {/* Publishing state */}
        {state === 'publishing' && (
          <div className="text-center py-8">
            <Loader2 className="w-10 h-10 text-purple-400 animate-spin mx-auto mb-4" />
            <p className="text-white font-medium">Publishing playlist...</p>
            <p className="text-sm text-gray-400 mt-1">Signing and broadcasting to relays</p>
          </div>
        )}

        {/* Success state */}
        {state === 'success' && (
          <>
            <div className="text-center mb-4">
              <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
                <Check className="w-6 h-6 text-green-400" />
              </div>
              <h2 className="text-xl font-bold text-white">Published!</h2>
              <p className="text-sm text-gray-400 mt-1">Your playlist is now on Nostr</p>
            </div>

            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">naddr</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={naddr}
                  readOnly
                  className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs font-mono truncate"
                />
                <button
                  onClick={handleCopy}
                  className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors flex-shrink-0"
                  title="Copy naddr"
                >
                  {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              onClick={handleClose}
              className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Done
            </button>
          </>
        )}

        {/* Error state */}
        {state === 'error' && (
          <>
            <div className="text-center mb-4">
              <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-bold text-white">Publish Failed</h2>
              <p className="text-sm text-red-400 mt-1">{errorMessage}</p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleRetry}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Try Again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
