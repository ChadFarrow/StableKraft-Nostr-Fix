import { useEffect } from 'react';
import { useAudio } from '@/contexts/AudioContext';
import { useRouter } from 'next/navigation';

/**
 * Global keyboard shortcuts for the application
 * 
 * Shortcuts:
 * - Space: Play/Pause
 * - Right Arrow: Next Track
 * - Left Arrow: Previous Track
 * - / (Slash): Focus Search
 * - Escape: Close modals/fullscreen
 */
export function useKeyboardShortcuts() {
  const { isPlaying, pause, resume, playNextTrack, playPreviousTrack, isFullscreenMode, setFullscreenMode } = useAudio();
  const router = useRouter();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        // Allow Escape even in inputs
        if (event.key !== 'Escape') {
          return;
        }
      }

      switch (event.key) {
        case ' ': // Space
          event.preventDefault();
          if (isPlaying) {
            pause();
          } else {
            resume();
          }
          break;

        case 'ArrowRight': // Next track
          event.preventDefault();
          playNextTrack();
          break;

        case 'ArrowLeft': // Previous track
          event.preventDefault();
          playPreviousTrack();
          break;

        case '/': // Focus search
          event.preventDefault();
          const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement;
          if (searchInput) {
            searchInput.focus();
          }
          break;

        case 'Escape': // Close modals
          event.preventDefault();
          if (isFullscreenMode) {
            setFullscreenMode(false);
          }
          // Blur active element
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, pause, resume, playNextTrack, playPreviousTrack, isFullscreenMode, setFullscreenMode, router]);
}
