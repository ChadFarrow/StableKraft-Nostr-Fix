'use client';

import React, { createContext, useContext, useRef, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { RSSAlbum } from '@/lib/rss-parser';
import { toast } from '@/components/Toast';
// Type-only import for TypeScript (hls.js is ~150KB, loaded dynamically when needed)
import type HlsType from 'hls.js';
import { monitoring } from '@/lib/monitoring';
import { storage } from '@/lib/indexed-db-storage';
import { useNostr } from './NostrContext';
import { useUserSettings } from '@/hooks/useUserSettings';
import { publishNowPlayingStatus, clearUserStatus } from '@/lib/nostr/nip38';
import { useBitcoinConnect } from '@/components/Lightning/BitcoinConnectProvider';
import { ValueSplitsService } from '@/lib/lightning/value-splits';
import { ValueRecipient } from '@/lib/lightning/value-parser';
import { hasV4V as checkHasV4V, getV4VRecipients, getPrimaryRecipient } from '@/lib/v4v-utils';
import { prefetchUpcomingTracks } from '@/lib/audio-prefetch';

interface AudioContextType {
  // Audio state
  currentPlayingAlbum: RSSAlbum | null;
  isPlaying: boolean;
  isLoading: boolean; // True when playback is starting (between click and audio playing)
  currentTrackIndex: number;
  currentTime: number;
  duration: number;

  // Media type state
  isVideoMode: boolean;

  // Shuffle state
  isShuffleMode: boolean;

  // UI state
  isFullscreenMode: boolean;
  setFullscreenMode: (fullscreen: boolean) => void;

  // Repeat mode
  repeatMode: 'none' | 'one' | 'all';
  setRepeatMode: (mode: 'none' | 'one' | 'all') => void;
  
  // Audio controls
  playAlbum: (album: RSSAlbum, trackIndex?: number) => Promise<boolean>;
  playTrack: (audioUrl: string, startTime?: number, endTime?: number) => Promise<boolean>;
  playShuffledTrack: (index: number) => Promise<boolean>;
  shuffleAllTracks: () => Promise<boolean>;
  shuffleAlbums: (albums: RSSAlbum[]) => Promise<boolean>;
  toggleShuffle: () => void;
  pause: () => void;
  resume: () => void;
  seek: (time: number) => void;
  playNextTrack: () => void;
  playPreviousTrack: () => void;
  stop: () => void;
  
  // Media element refs for direct access
  audioRef: React.RefObject<HTMLAudioElement>;
  videoRef: React.RefObject<HTMLVideoElement>;

  // Pre-load albums (for server-side fetched data)
  setInitialAlbums: (albums: RSSAlbum[]) => void;
}

const AudioContext = createContext<AudioContextType | undefined>(undefined);

export const useAudio = () => {
  const context = useContext(AudioContext);
  if (!context) {
    throw new Error('useAudio must be used within an AudioProvider');
  }
  return context;
};

interface AudioProviderProps {
  children: ReactNode;
  radioMode?: boolean;
}

export const AudioProvider: React.FC<AudioProviderProps> = ({ children, radioMode = false }) => {
  const [currentPlayingAlbum, setCurrentPlayingAlbum] = useState<RSSAlbum | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false); // True when playback is starting
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [albums, setAlbums] = useState<RSSAlbum[]>([]);
  const [hasUserInteracted, setHasUserInteracted] = useState(false);

  // Video mode state
  const [isVideoMode, setIsVideoMode] = useState(false);

  // Shuffle state
  const [isShuffleMode, setIsShuffleMode] = useState(false);
  const [shuffledPlaylist, setShuffledPlaylist] = useState<Array<{
    album: RSSAlbum;
    trackIndex: number;
    track: any;
  }>>([]);
  const [currentShuffleIndex, setCurrentShuffleIndex] = useState(0);

  // UI state
  const [isFullscreenMode, setIsFullscreenMode] = useState(false);
  const [repeatMode, setRepeatMode] = useState<'none' | 'one' | 'all'>('none');

  // iOS detection state (for JSX conditional rendering)
  const [isIOS, setIsIOS] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const albumsLoadedRef = useRef(false);
  const isRetryingRef = useRef(false);
  const skipAutoSkipRef = useRef(false); // Prevent auto-skip when failure is handled programmatically
  const playbackSessionRef = useRef(0); // Session ID to cancel stale playback attempts
  const autoSkipTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Track pending auto-skip to cancel on manual skip
  const isAutoTransitioningRef = useRef(false); // Track when transitioning from ended track (for iOS)
  const isInitializingHlsRef = useRef(false); // Prevent HLS cleanup during initialization
  const playNextTrackRef = useRef<() => Promise<void>>();
  const playPreviousTrackRef = useRef<() => Promise<void>>();
  const pauseRef = useRef<() => void>();
  const resumeRef = useRef<() => void>();
  const updateMediaSessionRef = useRef<() => void>();

  // Silent stall detection refs - detect when audio stops advancing while supposedly playing
  const lastKnownTimeRef = useRef<number>(0);
  const staleTimeCounterRef = useRef<number>(0);
  const stallCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recoveryAttemptRef = useRef<number>(0);
  const userInitiatedPauseRef = useRef<boolean>(false); // Track if pause was user-initiated

  // iOS background audio keepalive refs
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const keepaliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isInBackgroundRef = useRef(false);

  // Web Audio API for volume normalization (compressor)
  const webAudioContextRef = useRef<AudioContext | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const videoSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  // Track if Web Audio has been activated - once true, ALL external audio must use proxy
  // This prevents silence from cross-origin audio going through Web Audio without CORS headers
  const webAudioActivatedRef = useRef<boolean>(false);

  // NIP-38 status publishing
  const { user, isAuthenticated } = useNostr();
  const { settings } = useUserSettings();
  const nip38TimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastPublishedNip38TrackRef = useRef<string | null>(null);

  // Auto-boost support
  const { isConnected: isWalletConnected, sendPayment, sendKeysend, supportsKeysend } = useBitcoinConnect();
  const autoBoostProcessingRef = useRef(false);

  // Helper function to publish NIP-38 status (debounced)
  const publishNip38StatusDebounced = useCallback((action: 'play') => {
    // Clear any pending timeout
    if (nip38TimeoutRef.current) {
      clearTimeout(nip38TimeoutRef.current);
    }

    // Check if auto-status is enabled, user is authenticated, and not in radio mode
    if (!settings.nip38AutoStatus || !isAuthenticated || radioMode) {
      return;
    }

    // Debounce status updates to avoid spam (especially for rapid track changes)
    nip38TimeoutRef.current = setTimeout(async () => {
      try {
        if (action === 'play' && currentPlayingAlbum && currentPlayingAlbum.tracks[currentTrackIndex]) {
          const track = currentPlayingAlbum.tracks[currentTrackIndex];

          // Generate unique identifier for this track
          const trackIdentifier = track.id || track.guid || track.url || '';

          // Check if this is the same track we already published
          if (lastPublishedNip38TrackRef.current === trackIdentifier) {
            console.log('⏭️ NIP-38: Skipping duplicate status for same track');
            return;
          }

          const currentElement = isVideoMode ? videoRef.current : audioRef.current;

          // Construct track page URL on this site
          const baseUrl = typeof window !== 'undefined'
            ? window.location.origin
            : (process.env.NEXT_PUBLIC_BASE_URL || 'https://stablekraft.app');

          const trackPageUrl = trackIdentifier ? `${baseUrl}/music-tracks/${encodeURIComponent(trackIdentifier)}` : track.url;

          // Publish "now playing" status - persists as "last played" until next track
          await publishNowPlayingStatus(
            track.title || 'Unknown Track',
            track.artist || currentPlayingAlbum.artist || 'Unknown Artist',
            {
              trackTitle: track.title,
              artistName: track.artist || currentPlayingAlbum.artist,
              albumTitle: currentPlayingAlbum.title,
              trackUrl: trackPageUrl, // Link to track page on this site
              trackGuid: track.guid,
              feedGuid: currentPlayingAlbum.feedGuid,
              durationSeconds: currentElement?.duration || duration,
              currentTimeSeconds: currentElement?.currentTime || currentTime,
              imageUrl: track.image || currentPlayingAlbum.coverArt || undefined,
            },
            user?.relays
          );

          // Store this track as the last published
          lastPublishedNip38TrackRef.current = trackIdentifier;
        }
        // Status persists - never cleared automatically
      } catch (error) {
        // Silently fail - don't disrupt playback
        console.warn('Failed to publish NIP-38 status:', error);
      }
    }, 500); // 500ms debounce
  }, [settings.nip38AutoStatus, isAuthenticated, currentPlayingAlbum, currentTrackIndex, isVideoMode, duration, currentTime, user?.relays]);

  // Auto-boost trigger function - fire and forget, doesn't block playback
  const triggerAutoBoost = useCallback(async (track: any, album: RSSAlbum, amount: number) => {
    // Prevent concurrent auto-boosts
    if (autoBoostProcessingRef.current) {
      console.log('⚡ Auto-boost already in progress, skipping');
      return;
    }

    // Check if wallet is connected
    if (!isWalletConnected) {
      console.log('⚡ Auto-boost skipped: wallet not connected');
      return;
    }

    // Check if track has V4V data
    if (!checkHasV4V(track)) {
      console.log('⚡ Auto-boost skipped: no V4V data for track');
      return;
    }

    autoBoostProcessingRef.current = true;

    try {
      console.log(`⚡ Auto-boost starting: ${amount} sats for "${track.title}"`);

      // Build Helipad metadata
      const helipadMetadata: any = {
        podcast: album.artist || 'Unknown Artist',
        episode: track.title || 'Unknown Track',
        action: 'auto', // Helipad action type 4 = automated boost
        app_name: 'StableKraft',
        value_msat: amount * 1000,
        value_msat_total: amount * 1000,
        sender_name: settings.defaultBoostName ? `${settings.defaultBoostName} via StableKraft.app` : 'StableKraft.app user',
        ts: Math.floor(Date.now() / 1000),
        uuid: `auto-${Date.now()}-${Math.floor(Math.random() * 999)}`
      };

      // Add optional fields
      if (album.feedUrl) {
        helipadMetadata.url = album.feedUrl;
        helipadMetadata.feed = album.feedUrl;
      }
      if (album.id) {
        helipadMetadata.feedId = album.id;
      }
      if (album.feedGuid) {
        helipadMetadata.remote_feed_guid = album.feedGuid;
      }
      if (track.guid || track.id) {
        helipadMetadata.remote_item_guid = track.guid || track.id;
        helipadMetadata.episode_guid = track.guid || track.id;
      }
      if (album.title) {
        helipadMetadata.album = album.title;
      }

      console.log('📋 Auto-boost Helipad metadata:', helipadMetadata);

      let result: { preimage?: string; error?: string } | null = null;

      // Check if we have value splits (multiple recipients)
      const v4vRecipients = getV4VRecipients(track);
      if (v4vRecipients.length > 0) {
        // Multi-recipient payment via value splits
        const recipients: ValueRecipient[] = v4vRecipients.map((r) => ({
          name: r.name || 'Unknown',
          type: r.type === 'lnaddress' ? 'lnaddress' : 'node',
          address: r.address,
          split: r.split || 100,
        }));

        console.log(`⚡ Auto-boost: sending to ${recipients.length} recipients`);

        const multiResult = await ValueSplitsService.sendMultiRecipientPayment(
          recipients,
          amount,
          sendPayment,
          sendKeysend,
          undefined, // No message for auto-boost
          helipadMetadata,
          undefined, // No progress callback for auto-boost
          undefined, // walletType
          supportsKeysend
        );

        if (multiResult.success || multiResult.isPartialSuccess) {
          result = { preimage: multiResult.primaryPreimage };
        } else {
          result = { error: multiResult.errors.join(', ') };
        }
      } else {
        // Single recipient keysend (fallback to v4vRecipient)
        const primaryRecipient = getPrimaryRecipient(track);
        if (primaryRecipient) {
          console.log(`⚡ Auto-boost: sending to single recipient ${primaryRecipient}`);
          result = await sendKeysend(primaryRecipient, amount, undefined, helipadMetadata);
        }
      }

      if (result?.preimage) {
        console.log(`✅ Auto-boost successful: ${amount} sats`);

        // Log boost to database (without Nostr posting)
        try {
          await fetch('/api/lightning/log-boost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trackId: track.id,
              feedId: album.id,
              amount: amount,
              message: '', // No message for auto-boost
              senderName: settings.defaultBoostName || 'StableKraft.app user',
              preimage: result.preimage,
              type: 'auto', // Mark as auto-boost
              recipient: getPrimaryRecipient(track) || 'value-splits'
            })
          });
        } catch (logError) {
          console.warn('⚠️ Failed to log auto-boost:', logError);
        }

        // Show subtle toast notification
        toast.success(`Auto-boost: ${amount} sats ⚡`);
      } else {
        console.warn(`⚠️ Auto-boost failed: ${result?.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('❌ Auto-boost error:', error);
    } finally {
      autoBoostProcessingRef.current = false;
    }
  }, [isWalletConnected, sendPayment, sendKeysend, supportsKeysend, settings.defaultBoostName]);

  // Store auto-boost function in ref for use in event handlers
  const triggerAutoBoostRef = useRef(triggerAutoBoost);
  useEffect(() => {
    triggerAutoBoostRef.current = triggerAutoBoost;
  }, [triggerAutoBoost]);

  // Detect iOS devices - Web Audio interferes with background playback on iOS
  const isIOSDevice = useCallback(() => {
    if (typeof navigator === 'undefined') return false;
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad on iOS 13+
  }, []);

  // Set iOS state on mount for JSX conditional rendering
  useEffect(() => {
    setIsIOS(isIOSDevice());
  }, [isIOSDevice]);

  // iOS background audio keepalive - plays silent audio to keep audio session alive
  const startSilentKeepalive = useCallback(() => {
    if (!isIOSDevice() || keepaliveIntervalRef.current) return;

    console.log('📱 Starting iOS silent keepalive');

    if (!silentAudioRef.current) {
      const silent = new Audio('/silent-500ms.mp3');
      silent.loop = true;
      silent.volume = 0.001; // Near-silent but not zero (zero might be optimized out)
      silentAudioRef.current = silent;
    }

    silentAudioRef.current.play().catch(() => {
      // Ignore errors - might fail if no user interaction yet
    });

    // Re-assert media session metadata after starting silent audio
    // iOS may reset metadata when a new audio element starts playing
    setTimeout(() => {
      if (updateMediaSessionRef.current) {
        console.log('📱 Re-asserting media session metadata after keepalive start');
        updateMediaSessionRef.current();
      }
    }, 100);

    // Periodically re-trigger play to ensure session stays alive
    keepaliveIntervalRef.current = setInterval(() => {
      if (isInBackgroundRef.current && silentAudioRef.current) {
        silentAudioRef.current.play().catch(() => {});
      }
    }, 10000); // Every 10 seconds
  }, [isIOSDevice]);

  const stopSilentKeepalive = useCallback(() => {
    if (keepaliveIntervalRef.current) {
      clearInterval(keepaliveIntervalRef.current);
      keepaliveIntervalRef.current = null;
    }
    if (silentAudioRef.current) {
      silentAudioRef.current.pause();
    }
    console.log('📱 Stopped iOS silent keepalive');
  }, []);

  // Initialize Web Audio API for volume normalization (compressor)
  // SKIP on iOS - Web Audio breaks background playback when app is minimized
  const initWebAudio = useCallback(() => {
    if (webAudioContextRef.current) return;

    // Skip Web Audio on iOS to preserve background playback
    if (isIOSDevice()) {
      console.log('📱 Skipping Web Audio on iOS to preserve background playback');
      return;
    }

    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      webAudioContextRef.current = ctx;

      // Create compressor with music normalization settings
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;  // Start compressing at -24dB
      compressor.knee.value = 30;        // Soft knee for natural sound
      compressor.ratio.value = 12;       // 12:1 compression ratio
      compressor.attack.value = 0.003;   // 3ms attack
      compressor.release.value = 0.25;   // 250ms release
      compressor.connect(ctx.destination);
      compressorRef.current = compressor;

      console.log('🔊 Web Audio initialized for volume normalization');
    } catch (err) {
      console.warn('⚠️ Web Audio not available:', err);
    }
  }, [isIOSDevice]);

  // Ensure Web Audio context is running (call on every playback)
  const ensureWebAudioRunning = useCallback(() => {
    const ctx = webAudioContextRef.current;
    if (ctx && ctx.state === 'suspended') {
      console.log('🔊 Resuming suspended Web Audio context');
      ctx.resume().catch(err => {
        console.warn('⚠️ Failed to resume Web Audio context:', err);
      });
    }
  }, []);

  // Connect media element to compressor for volume normalization
  const connectToCompressor = useCallback((mediaElement: HTMLMediaElement, isVideo: boolean) => {
    if (!webAudioContextRef.current || !compressorRef.current) {
      return false;
    }

    const ctx = webAudioContextRef.current;
    const sourceRef = isVideo ? videoSourceRef : audioSourceRef;

    // Always resume audio context if suspended (critical for continued playback)
    ensureWebAudioRunning();

    // MediaElementSourceNode can only be created once per element
    if (!sourceRef.current) {
      try {
        const source = ctx.createMediaElementSource(mediaElement);
        source.connect(compressorRef.current);
        sourceRef.current = source;
        // Mark Web Audio as activated - from now on, ALL external audio must use proxy
        // to prevent silence from cross-origin audio without CORS headers
        webAudioActivatedRef.current = true;
        console.log(`🔊 ${isVideo ? 'Video' : 'Audio'} connected to compressor for volume normalization (Web Audio now active)`);
        return true;
      } catch (err) {
        // CORS error or already connected - audio will play without normalization
        console.log('⚠️ Cannot connect to compressor (likely CORS restriction):', err);
        return false;
      }
    }

    return true; // Already connected
  }, [ensureWebAudioRunning]);

  // AudioContext state version - increment when structure changes to invalidate old cache
  const AUDIO_STATE_VERSION = 2; // v2 includes V4V fields in tracks

  // Load state from IndexedDB on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      storage.getItem('audioPlayerState').then((savedState) => {
        if (savedState) {
          try {
            const state = typeof savedState === 'string' ? JSON.parse(savedState) : savedState;

            // Check cache version - invalidate if version mismatch
            if (state.version !== AUDIO_STATE_VERSION) {
              console.log(`🔄 AudioContext cache version mismatch (${state.version} !== ${AUDIO_STATE_VERSION}), clearing old cache`);
              storage.removeItem('audioPlayerState');
              return;
            }

            // Restore shuffle state
            if (state.isShuffleMode !== undefined) {
              setIsShuffleMode(state.isShuffleMode);
            }
            if (state.currentShuffleIndex !== undefined) {
              setCurrentShuffleIndex(state.currentShuffleIndex);
            }

            // Restore track index and timing info
            setCurrentTrackIndex(state.currentTrackIndex || 0);
            setCurrentTime(state.currentTime || 0);
            setDuration(state.duration || 0);

            // Note: isPlaying is not restored to prevent autoplay issues
            // Note: currentPlayingAlbum will be restored when needed by playNextTrack

            if (process.env.NODE_ENV === 'development') {
              console.log('🔄 Restored audio state from IndexedDB:', {
                version: state.version,
                trackIndex: state.currentTrackIndex,
                shuffleMode: state.isShuffleMode,
                hasAlbumData: !!state.currentPlayingAlbum
              });
            }
          } catch (error) {
            console.warn('Failed to restore audio state:', error);
          }
        }
      }).catch((error) => {
        console.error('IndexedDB getItem error:', error);
      });
    }
  }, []);

  // Add user interaction handler to enable audio playback
  useEffect(() => {
    // Check if we're on mobile
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (isMobile) {
      console.log('📱 Mobile device detected - audio will play on first track click');
    }

    // No need for generic interaction handlers - playAlbum will handle it
    return () => {};
  }, []); // Run only once on mount

  // Initialize Media Session API early for iOS 26 lockscreen controls
  useEffect(() => {
    if ('mediaSession' in navigator && navigator.mediaSession) {
      try {
        // Register action handlers immediately on mount (before any playback)
        // This is required for iOS 26 PWA mode to recognize media capabilities
        // Using refs with DOM fallback for iOS background reliability
        navigator.mediaSession.setActionHandler('play', () => {
          console.log('📱 Media session: Play action received');
          if (resumeRef.current) {
            resumeRef.current();
          }
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          console.log('📱 Media session: Pause action received');
          if (pauseRef.current) {
            pauseRef.current();
          }
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
          console.log('📱 Media session: Previous track from early init');
          if (playPreviousTrackRef.current) {
            playPreviousTrackRef.current();
          }
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          console.log('📱 Media session: Next track from early init');
          if (playNextTrackRef.current) {
            playNextTrackRef.current();
          }
        });

        // Explicitly disable seek handlers - we only support track navigation
        // This prevents iOS from showing skip forward/back buttons
        navigator.mediaSession.setActionHandler('seekbackward', null);
        navigator.mediaSession.setActionHandler('seekforward', null);
        navigator.mediaSession.setActionHandler('seekto', null);

        // Set initial playback state to 'none' - will be updated when playback starts
        navigator.mediaSession.playbackState = 'none';

        console.log('📱 Media Session initialized on mount for iOS 26');
      } catch (error) {
        console.warn('Failed to initialize Media Session early:', error);
      }
    }
  }, []); // Run only once on mount

  // iOS Background Audio Fix: Handle visibility changes (screen lock/unlock)
  // When the user locks their phone, iOS may pause audio. This handler resumes playback
  // when the app becomes visible again (user unlocks phone).
  const wasPlayingBeforeHiddenRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === 'visible';

      if (!isVisible) {
        // Page is being hidden (screen locked or app backgrounded)
        isInBackgroundRef.current = true;

        // Remember if we were playing so we can resume
        const audio = document.getElementById('stablekraft-audio-player') as HTMLAudioElement;
        const video = document.getElementById('stablekraft-video-player') as HTMLVideoElement;
        wasPlayingBeforeHiddenRef.current = !!(
          (audio && !audio.paused) ||
          (video && !video.paused)
        );
        console.log('📱 Page hidden, was playing:', wasPlayingBeforeHiddenRef.current);

        // Start silent keepalive on iOS when going to background while playing
        if (wasPlayingBeforeHiddenRef.current) {
          startSilentKeepalive();
        }
      } else {
        // Page is visible again (screen unlocked)
        isInBackgroundRef.current = false;
        console.log('📱 Page visible, checking audio state...');

        // Stop silent keepalive when returning to foreground
        stopSilentKeepalive();

        // Resume Web Audio context if suspended
        const ctx = webAudioContextRef.current;
        if (ctx && ctx.state === 'suspended') {
          console.log('🔊 Resuming suspended Web Audio context after visibility change');
          ctx.resume().catch(err => {
            console.warn('⚠️ Failed to resume Web Audio context:', err);
          });
        }

        // Check if audio should be playing but isn't
        const audio = document.getElementById('stablekraft-audio-player') as HTMLAudioElement;
        const video = document.getElementById('stablekraft-video-player') as HTMLVideoElement;

        // If we were playing before and audio is now paused, try to resume
        if (wasPlayingBeforeHiddenRef.current) {
          if (audio && audio.paused && audio.currentTime > 0 && audio.src) {
            console.log('📱 Attempting to resume audio after visibility change');
            audio.play().then(() => {
              console.log('✅ Audio resumed after screen unlock');
              if ('mediaSession' in navigator && navigator.mediaSession) {
                navigator.mediaSession.playbackState = 'playing';
              }
            }).catch(err => {
              console.warn('⚠️ Failed to resume audio:', err);
            });
          }
          if (video && video.paused && video.currentTime > 0 && video.src) {
            console.log('📱 Attempting to resume video after visibility change');
            video.play().then(() => {
              console.log('✅ Video resumed after screen unlock');
              if ('mediaSession' in navigator && navigator.mediaSession) {
                navigator.mediaSession.playbackState = 'playing';
              }
            }).catch(err => {
              console.warn('⚠️ Failed to resume video:', err);
            });
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also handle pageshow event - more reliable on iOS for app switching
    const handlePageShow = (event: PageTransitionEvent) => {
      // event.persisted is true when page is restored from bfcache
      console.log('📱 pageshow event, persisted:', event.persisted);

      // Resume Web Audio context if needed
      const ctx = webAudioContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        console.log('🔊 Resuming Web Audio context on pageshow');
        ctx.resume().catch(err => {
          console.warn('⚠️ Failed to resume Web Audio on pageshow:', err);
        });
      }

      // Check if audio was interrupted and needs to be resumed
      if (wasPlayingBeforeHiddenRef.current) {
        const audio = document.getElementById('stablekraft-audio-player') as HTMLAudioElement;
        if (audio && audio.paused && audio.currentTime > 0 && audio.src) {
          console.log('📱 Resuming audio on pageshow');
          audio.play().catch(err => {
            console.warn('⚠️ Failed to resume audio on pageshow:', err);
          });
        }
      }
    };

    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [startSilentKeepalive, stopSilentKeepalive]); // Re-run when keepalive functions change

  // Save state to IndexedDB when it changes - with debouncing
  useEffect(() => {
    if (typeof window !== 'undefined' && currentPlayingAlbum) {
      const timeoutId = setTimeout(async () => {
        const state = {
          version: AUDIO_STATE_VERSION, // Include version for cache invalidation
          currentPlayingAlbum: {
            title: currentPlayingAlbum.title,
            artist: currentPlayingAlbum.artist,
            coverArt: currentPlayingAlbum.coverArt,
            feedId: currentPlayingAlbum.feedId,
            feedUrl: currentPlayingAlbum.feedUrl,
            feedGuid: currentPlayingAlbum.feedGuid,
            tracks: currentPlayingAlbum.tracks?.map(track => ({
              title: track.title,
              audioUrl: track.url,
              startTime: track.startTime,
              endTime: track.endTime,
              // Include V4V fields for Lightning payments
              v4vRecipient: track.v4vRecipient,
              v4vValue: track.v4vValue,
              guid: track.guid,
              image: track.image
            }))
          },
          currentTrackIndex,
          currentTime,
          duration,
          isShuffleMode,
          shuffledPlaylist: shuffledPlaylist.map(item => ({
            albumTitle: item.album.title,
            trackIndex: item.trackIndex,
            trackTitle: item.track.title
          })),
          currentShuffleIndex,
          timestamp: Date.now()
        };
        await storage.setItem('audioPlayerState', state);
      }, 100); // Debounce to prevent excessive writes

      return () => clearTimeout(timeoutId);
    }
  }, [currentPlayingAlbum, currentTrackIndex, currentTime, duration, isShuffleMode, shuffledPlaylist, currentShuffleIndex]);

  // Load albums data for playback - with retry logic for cold starts
  useEffect(() => {
    const loadAlbums = async (retryCount = 0): Promise<void> => {
      // Prevent multiple loads if already loaded successfully
      if (albumsLoadedRef.current) {
        return;
      }

      // Small delay on first attempt to allow setInitialAlbums from server-side fetch to run first
      if (retryCount === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Check again after delay in case setInitialAlbums ran
        if (albumsLoadedRef.current) {
          return;
        }
      }

      const maxRetries = 5;
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const retryDelay = Math.min(2000 * Math.pow(2, retryCount), 32000);

      try {
        // Create AbortController for timeout handling
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch('/api/albums?limit=0', {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Cache-Control': 'no-cache'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        
        if (response.ok) {
          // Check if response is valid JSON
          const contentType = response.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            console.warn('⚠️ Albums API returned non-JSON response:', contentType);
            return;
          }
          
          const data = await response.json();
          if (data && Array.isArray(data.albums)) {
            setAlbums(data.albums);
            albumsLoadedRef.current = true; // Only mark as loaded after success
            // Only log in development mode
            if (process.env.NODE_ENV === 'development') {
              console.log(`✅ Loaded ${data.albums.length} albums for audio context`);

              // Debug: Check if Delta OG album has V4V data
              const deltaOGAlbum = data.albums.find((album: any) => album.title?.includes('Aged Friends'));
              if (deltaOGAlbum) {
                const deltaOGTrack = deltaOGAlbum.tracks?.[0];
                console.log('🔍 AudioContext Delta OG track debug:', {
                  albumTitle: deltaOGAlbum.title,
                  trackTitle: deltaOGTrack?.title,
                  trackKeys: deltaOGTrack ? Object.keys(deltaOGTrack) : [],
                  hasV4vRecipient: !!deltaOGTrack?.v4vRecipient,
                  hasV4vValue: !!deltaOGTrack?.v4vValue,
                  v4vRecipient: deltaOGTrack?.v4vRecipient,
                  v4vValue: deltaOGTrack?.v4vValue
                });
              }
            }
          } else {
            console.warn('⚠️ Albums API returned invalid data structure:', data);
          }
        } else {
          console.warn(`⚠️ Albums API returned ${response.status}: ${response.statusText}`);
          // Retry on non-ok response
          if (retryCount < maxRetries - 1) {
            console.log(`⏳ Retrying album load in ${retryDelay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return loadAlbums(retryCount + 1);
          }
        }
      } catch (error) {
        console.warn(`Failed to load albums (attempt ${retryCount + 1}/${maxRetries}):`, error);

        // Retry on failure if under max retries
        if (retryCount < maxRetries - 1) {
          console.log(`⏳ Retrying album load in ${retryDelay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return loadAlbums(retryCount + 1);
        }
        // Don't throw - allow the app to continue without albums
      }
    };

    loadAlbums(0);
  }, []); // Run only once on mount

  // Helper function to detect if URL is a video
  const isVideoUrl = (url: string, mediaType?: string): boolean => {
    if (!url || typeof url !== 'string') return false;
    // If mediaType explicitly says video, trust it
    if (mediaType === 'video') return true;
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.m3u8', '.m4v', '.mov', '.avi', '.mkv', '.moov'];
    const urlLower = url.toLowerCase();
    return videoExtensions.some(ext => urlLower.includes(ext));
  };

  // Helper function to get the best playback URL from a track
  // Prefers video URL from alternateEnclosures when mediaType is 'video'
  const getTrackPlaybackUrl = (track: any): string => {
    console.log('🔍 getTrackPlaybackUrl called with track:', {
      title: track?.title,
      mediaType: track?.mediaType,
      hasAlternateEnclosures: !!track?.alternateEnclosures,
      alternateEnclosuresLength: track?.alternateEnclosures?.length,
      url: track?.url
    });

    // If track has video alternateEnclosures, prefer the video URL
    if (track?.mediaType === 'video' && track?.alternateEnclosures?.length > 0) {
      const videoEnclosure = track.alternateEnclosures.find((enc: any) =>
        enc.url && (enc.type?.includes('video') || enc.type === 'mp4' || enc.type === 'webm')
      );
      if (videoEnclosure?.url) {
        console.log('🎬 Using video URL from alternateEnclosures:', videoEnclosure.url);
        return videoEnclosure.url;
      }
    }
    // Fallback to regular audio URL
    console.log('🔊 Using audio URL:', track?.url);
    return track?.url || '';
  };

  // Helper function to detect if URL is an HLS stream
  const isHlsUrl = (url: string): boolean => {
    return Boolean(url && typeof url === 'string' && url.toLowerCase().includes('.m3u8'));
  };

  // Helper function to get URLs to try for audio/video playback
  const getAudioUrlsToTry = (originalUrl: string): string[] => {
    const urlsToTry = [];

    console.log('🔍 [URL Strategy] Processing URL:', originalUrl);

    if (!originalUrl || typeof originalUrl !== 'string') {
      console.warn('⚠️ Invalid audio URL provided:', originalUrl);
      return [];
    }

    // Sanitize URL: encode spaces that aren't already encoded
    // Many RSS feeds have unencoded spaces in URLs which break playback
    let sanitizedUrl = originalUrl;
    if (originalUrl.includes(' ') && !originalUrl.includes('%20')) {
      sanitizedUrl = originalUrl.replace(/ /g, '%20');
      console.log('🔧 [URL Strategy] Encoded spaces in URL');
    }

    try {
      // Extract direct URL from op3.dev analytics wrapper FIRST (before HLS check)
      // This ensures HLS streams wrapped in op3.dev are handled correctly
      let effectiveUrl = sanitizedUrl;
      if (sanitizedUrl.includes('op3.dev/e/') && sanitizedUrl.includes('/https://')) {
        const directUrl = sanitizedUrl.split('/https://')[1];
        if (directUrl) {
          effectiveUrl = `https://${directUrl}`;
          console.log('🔗 [URL Strategy] Extracted direct URL from op3.dev:', effectiveUrl);
        }
      }

      const url = new URL(effectiveUrl);
      const isExternal = url.hostname !== window.location.hostname;
      const isHls = isHlsUrl(effectiveUrl);

      console.log(`🔍 [URL Strategy] Parsed - hostname: ${url.hostname}, isExternal: ${isExternal}, isHls: ${isHls}`);

      // Special handling for HLS streams
      if (isHls) {
        // Cloudflare Stream has CORS enabled and uses relative URLs in manifests,
        // so we MUST use direct URL (proxy breaks relative segment resolution)
        const isCloudflareStream = url.hostname.includes('cloudflarestream.com');
        if (isCloudflareStream) {
          console.log('📺 [URL Strategy] Cloudflare Stream HLS - using direct URL (has CORS)');
          urlsToTry.push(effectiveUrl);
        } else {
          // For other HLS streams, try proxy first, then direct
          console.log('📺 [URL Strategy] HLS stream detected - using proxy + direct fallback');
          urlsToTry.push(`/api/proxy-video?url=${encodeURIComponent(effectiveUrl)}`);
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(effectiveUrl)}`);
          urlsToTry.push(effectiveUrl);
        }
        console.log('📋 [URL Strategy] Final URLs to try:', urlsToTry.length, 'URLs');
        return urlsToTry;
      }

      // Special handling for op3.dev analytics URLs - extract direct URL (for non-HLS)
      if (sanitizedUrl.includes('op3.dev/e/') && sanitizedUrl.includes('/https://')) {
        console.log('🔗 [URL Strategy] op3.dev analytics URL detected');
        const directUrl = sanitizedUrl.split('/https://')[1];
        if (directUrl) {
          const fullDirectUrl = `https://${directUrl}`;
          console.log('🔗 Extracted direct URL from op3.dev:', fullDirectUrl);
          // Try direct URL first for better reliability
          urlsToTry.push(fullDirectUrl);
          // Then try proxy with direct URL
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(fullDirectUrl)}`);
          // Fallback to original op3 URL with proxy
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(sanitizedUrl)}`);
          // Last resort: original op3 URL direct
          urlsToTry.push(sanitizedUrl);
        } else {
          // If extraction fails, use normal logic
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(sanitizedUrl)}`);
          urlsToTry.push(sanitizedUrl);
        }
      } else if (isExternal) {
        // CRITICAL: If Web Audio has been activated, ALWAYS use proxy for external URLs
        // Once createMediaElementSource() connects an element to Web Audio, ALL audio
        // from that element goes through Web Audio. Cross-origin audio without CORS
        // headers outputs SILENCE as a security measure. Using proxy ensures CORS headers.
        if (webAudioActivatedRef.current) {
          console.log('🔊 [URL Strategy] Web Audio active - forcing proxy for CORS compliance');
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(sanitizedUrl)}`);
          console.log('📋 [URL Strategy] Final URLs to try:', urlsToTry.length, 'URLs');
          return urlsToTry;
        }

        // Normalize hostname for case-insensitive matching
        const hostname = url.hostname.toLowerCase();

        // Domains that should try direct first (known to have CORS enabled)
        const directFirstDomains = [
          'rssblue.com',
          'strangetextures.com',
          'thisisjdog.com',
          'heycitizen.xyz',
          'bitpunk.fm',
          'thebearsnare.com'
        ];

        // Check if URL is from a known CORS-problematic domain
        const corsProblematicDomains = [
          'cloudfront.net',
          'amazonaws.com',
          'wavlake.com',
          'buzzsprout.com',
          'anchor.fm',
          'libsyn.com',
          'whitetriangles.com',
          'falsefinish.club',
          'behindthesch3m3s.com',
          'doerfelverse.com',
          'sirtjthewrathful.com',
          'digitaloceanspaces.com',
          'rocknrollbreakheart.com',
          'mmmusic.show',
          'cypherpunk.today',
          'thunderroad.media'
        ];

        const isDirectFirst = directFirstDomains.some(domain =>
          hostname.includes(domain.toLowerCase())
        );

        // Case-insensitive domain matching
        const isDomainProblematic = corsProblematicDomains.some(domain =>
          hostname.includes(domain.toLowerCase())
        );

        // Extra check for CloudFront subdomains explicitly
        const isCloudFront = hostname.endsWith('.cloudfront.net') || hostname === 'cloudfront.net';

        console.log(`🔍 [URL Strategy] Domain check - hostname: ${hostname}, problematic: ${isDomainProblematic}, isCloudFront: ${isCloudFront}, directFirst: ${isDirectFirst}`);

        if (isDomainProblematic || isCloudFront) {
          // For known CORS-problematic domains, use proxy first and skip direct URL
          console.log(`🚫 [URL Strategy] CORS-problematic domain detected (${hostname}) - PROXY ONLY`);
          monitoring.info('audio-playback', `CORS-problematic domain detected: ${hostname}`, { sanitizedUrl });
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(sanitizedUrl)}`);
        } else if (isDirectFirst) {
          // For domains known to work directly, try direct first for faster playback
          console.log(`⚡ [URL Strategy] Direct-first domain (${hostname}) - direct then proxy fallback`);
          urlsToTry.push(sanitizedUrl);
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(sanitizedUrl)}`);
        } else {
          console.log(`✅ [URL Strategy] External domain OK (${hostname}) - proxy first, then direct fallback`);
          // For other external URLs, try proxy first then direct as fallback
          urlsToTry.push(`/api/proxy-audio?url=${encodeURIComponent(sanitizedUrl)}`);
          urlsToTry.push(sanitizedUrl);
        }
      } else {
        console.log('🏠 [URL Strategy] Local URL - direct only');
        // For local URLs, try direct first
        urlsToTry.push(sanitizedUrl);
      }
    } catch (urlError) {
      console.warn('⚠️ Could not parse audio URL, using as-is:', sanitizedUrl, urlError);
      urlsToTry.push(sanitizedUrl);
    }

    console.log(`📋 [URL Strategy] Final strategy: ${urlsToTry.length} URL(s) to try:`, urlsToTry.map((u, i) =>
      `\n  ${i + 1}. ${u.includes('proxy-audio') ? '🔄 PROXY' : '📡 DIRECT'}: ${u.substring(0, 100)}${u.length > 100 ? '...' : ''}`
    ).join(''));

    return urlsToTry;
  };

  // Helper function to attempt HLS playback
  const attemptHlsPlayback = async (hlsUrl: string, context = 'HLS playback'): Promise<boolean> => {
    const videoElement = videoRef.current;

    if (!videoElement) {
      console.error('❌ Video element reference is null for HLS playback');
      return false;
    }

    // Set flag to prevent useEffect cleanup from destroying HLS during initialization
    isInitializingHlsRef.current = true;

    // Get URLs to try including proxied versions
    const urlsToTry = getAudioUrlsToTry(hlsUrl);
    console.log(`🔄 ${context}: Trying ${urlsToTry.length} HLS URLs`);

    for (let i = 0; i < urlsToTry.length; i++) {
      const currentUrl = urlsToTry[i];
      console.log(`🔄 ${context} attempt ${i + 1}/${urlsToTry.length}: ${typeof currentUrl === 'string' && currentUrl.includes('proxy-audio') ? 'Proxied HLS URL' : 'Direct HLS URL'}`);

      try {
        // Clean up any existing HLS instance
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }

        // Dynamically import hls.js only when needed (saves ~150KB from initial bundle)
        const { default: Hls } = await import('hls.js');

        if (Hls.isSupported()) {
          // Use hls.js for browsers that support it
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            // No xhrSetup needed - Cloudflare Stream has proper CORS headers
          });

          hlsRef.current = hls;

          // Clear any existing src to avoid conflicts
          videoElement.src = '';
          videoElement.load();

          // Set up event listeners
          const manifestParsed = new Promise<boolean>((resolve) => {
            let hasResolved = false;

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              console.log('✅ HLS manifest parsed successfully');
              // Don't try to play immediately, wait for video to be ready
            });

            hls.on(Hls.Events.LEVEL_LOADED, () => {
              console.log('✅ HLS level loaded, attempting playback');
              if (!hasResolved) {
                videoElement.play().then(() => {
                  console.log(`✅ ${context} started successfully`);
                  // Initialize Web Audio for volume normalization (HLS via hls.js)
                  // Only connect for proxied URLs to avoid CORS-related silence
                  const isProxied = typeof currentUrl === 'string' && currentUrl.includes('proxy-');
                  if (isProxied) {
                    initWebAudio();
                    connectToCompressor(videoElement, true);
                  }
                  hasResolved = true;
                  resolve(true);
                }).catch(error => {
                  console.error('❌ HLS playback failed:', error);
                  if (!hasResolved) {
                    hasResolved = true;
                    resolve(false);
                  }
                });
              }
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
              console.error('❌ HLS error:', data);
              if (data.fatal) {
                console.error('❌ Fatal HLS error, trying next URL');
                hls.destroy();
                hlsRef.current = null;
                if (!hasResolved) {
                  hasResolved = true;
                  resolve(false);
                }
              }
            });

            // Timeout after 10 seconds (reduced from 20s for faster fallback)
            setTimeout(() => {
              if (!hasResolved) {
                console.warn(`⏰ ${context} timed out for URL ${i + 1}`);
                hasResolved = true;
                resolve(false);
              }
            }, 10000);
          });

          // Load the HLS stream
          hls.loadSource(currentUrl);
          hls.attachMedia(videoElement);
          
          // Wait for manifest to be parsed and playback to start
          const success = await manifestParsed;
          if (success) {
            isInitializingHlsRef.current = false;
            return true;
          }
          
        } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS support
          console.log('🍎 Using Safari native HLS support');
          // Upgrade HTTP to HTTPS for security
          let secureUrl = currentUrl;
          if (currentUrl.startsWith('http://')) {
            secureUrl = currentUrl.replace(/^http:/, 'https:');
          }
          videoElement.src = secureUrl;
          videoElement.load();
          
          const playPromise = videoElement.play();
          if (playPromise !== undefined) {
            await playPromise;
            console.log(`✅ ${context} started successfully with Safari native HLS`);
            // Initialize Web Audio for volume normalization (Safari native HLS)
            // Only connect for proxied URLs to avoid CORS-related silence
            const isProxied = typeof currentUrl === 'string' && currentUrl.includes('proxy-');
            if (isProxied) {
              initWebAudio();
              connectToCompressor(videoElement, true);
            }
            isInitializingHlsRef.current = false;
            return true;
          }
        } else {
          console.error('❌ HLS not supported in this browser');
          toast.error('Video streaming not supported in this browser', { duration: 5000 });
          isInitializingHlsRef.current = false;
          return false;
        }
        
      } catch (error) {
        console.error(`❌ ${context} attempt ${i + 1} failed:`, error);
        
        // Clean up on error
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
        
        // Add a small delay before trying the next URL (reduced for faster skipping)
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.error(`❌ All ${urlsToTry.length} HLS URLs failed for ${context}`);
    isInitializingHlsRef.current = false;
    return false;
  };

  // Helper function to cancel pending auto-skip timeout
  const cancelPendingAutoSkip = () => {
    if (autoSkipTimeoutRef.current) {
      console.log('⏭️ Cancelling pending auto-skip timeout');
      clearTimeout(autoSkipTimeoutRef.current);
      autoSkipTimeoutRef.current = null;
    }
  };

  // Helper function to attempt media playback with fallback URLs
  const attemptAudioPlayback = async (originalUrl: string, context = 'playback', sessionId?: number, mediaType?: string): Promise<boolean> => {
    console.log('🎵 Attempting audio playback:', { originalUrl, context, mediaType });
    const isVideo = isVideoUrl(originalUrl, mediaType);
    const isHls = isHlsUrl(originalUrl);
    const mediaElement = isVideo ? videoRef.current : audioRef.current;

    if (!mediaElement) {
      console.error(`❌ ${isVideo ? 'Video' : 'Audio'} element reference is null`);
      return false;
    }

    // Update video mode state
    setIsVideoMode(isVideo);

    if (isVideo) {
      console.log('🎬 Video URL detected, switching to video mode:', originalUrl);
      // For video HLS content, open fullscreen mode BEFORE attempting playback
      // This ensures the video element is moved to a visible container,
      // which is required for HLS playback on some browsers that throttle hidden videos
      if (isHls) {
        console.log('🖥️ Opening fullscreen mode for video HLS playback');
        setIsFullscreenMode(true);

        // CRITICAL: Don't rely on React's render cycle - directly make video element
        // visible to prevent browser throttling of hidden video elements.
        // NowPlayingScreen will take control of positioning once it renders.
        const videoElement = videoRef.current;
        if (videoElement) {
          // Temporarily make video element visible (not off-screen)
          // Use a small size so it doesn't flash visibly before fullscreen opens
          videoElement.style.position = 'fixed';
          videoElement.style.left = '0';
          videoElement.style.top = '0';
          videoElement.style.width = '1px';
          videoElement.style.height = '1px';
          videoElement.style.opacity = '0.01'; // Nearly invisible but not display:none
        }

        // Small delay for the style changes to take effect
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    if (isHls) {
      console.log('📺 HLS stream detected, using hls.js:', originalUrl);
      return attemptHlsPlayback(originalUrl, context);
    }
    
    const urlsToTry = getAudioUrlsToTry(originalUrl);
    
    // Set retry flag to prevent error handler interference
    isRetryingRef.current = true;
    
    for (let i = 0; i < urlsToTry.length; i++) {
      // Check if this session is still current before each attempt
      if (sessionId !== undefined && playbackSessionRef.current !== sessionId) {
        console.log(`⏭️ Session ${sessionId} cancelled, newer session ${playbackSessionRef.current} active`);
        isRetryingRef.current = false;
        return false;
      }

      const audioUrl = urlsToTry[i];
      const isProxied = typeof audioUrl === 'string' && audioUrl.includes('proxy-audio');
      console.log(`🔄 [Playback Attempt ${i + 1}/${urlsToTry.length}] ${isProxied ? '🔄 PROXY' : '📡 DIRECT'}: ${audioUrl.substring(0, 150)}${audioUrl.length > 150 ? '...' : ''}`);

      try {
        // Clean up any existing HLS instance when switching to regular media
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      // Check if media element is still valid
      const currentMediaElement = isVideo ? videoRef.current : audioRef.current;
      if (!currentMediaElement) {
        console.error(`❌ ${isVideo ? 'Video' : 'Audio'} element became null during playback attempt`);
        return false;
      }
      
      // Clear any previous error state before setting new source
      currentMediaElement.pause();
      currentMediaElement.removeAttribute('src');
      currentMediaElement.load();

      // Upgrade HTTP to HTTPS for security and CORS compliance
      let secureAudioUrl = audioUrl;
      if (audioUrl.startsWith('http://')) {
        console.log(`⚠️ Upgrading HTTP audio URL to HTTPS: ${audioUrl}`);
        secureAudioUrl = audioUrl.replace(/^http:/, 'https:');
      }

      // Set new source and load
      currentMediaElement.src = secureAudioUrl;
      currentMediaElement.load();
        
        // Set volume for audio, videos typically control their own volume
        if (!isVideo) {
          (currentMediaElement as HTMLAudioElement).volume = 0.8;
        }
        
        // Wait briefly for media to load before playing
        // Reduced from 100ms to 10ms to prevent iOS from releasing audio session
        // in background playback. HLS streams may need slightly longer but seamless
        // playback handles track transitions anyway.
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Ensure media is not muted for playback
        currentMediaElement.muted = false;
        if (!isVideo) {
          (currentMediaElement as HTMLAudioElement).volume = 0.8;
        }
        
        const playPromise = currentMediaElement.play();
        if (playPromise !== undefined) {
          await playPromise;
          const isProxied = typeof audioUrl === 'string' && audioUrl.includes('proxy-audio');
          console.log(`✅ ${context} started successfully with ${isProxied ? 'proxied' : 'direct'} URL (${isVideo ? 'VIDEO' : 'AUDIO'} mode)`);
          
          // Monitor successful playback
          monitoring.info('audio-playback', `Playback success on attempt ${i + 1}`, {
            context,
            method: isProxied ? 'proxy' : 'direct',
            mode: isVideo ? 'video' : 'audio',
            url: originalUrl
          });

          // Initialize Web Audio and connect to compressor for volume normalization
          // IMPORTANT: Only connect for proxied URLs because:
          // 1. Once connected, ALL audio goes through Web Audio (can't undo)
          // 2. Cross-origin audio without CORS headers outputs SILENCE
          // 3. Our proxy has CORS headers, but direct URLs often don't
          if (isProxied) {
            initWebAudio();
            connectToCompressor(currentMediaElement, isVideo);
          }

          // Clear retry flag on success
          isRetryingRef.current = false;
          return true;
        }
      } catch (attemptError) {
        const errorMessage = attemptError instanceof Error ? attemptError.message : String(attemptError);
        const errorName = attemptError instanceof DOMException ? attemptError.name : 'Unknown';

        console.warn(`⚠️ [Playback Attempt ${i + 1} FAILED] Error: ${errorName} - ${errorMessage}`);
        console.warn(`⚠️ [Playback Attempt ${i + 1} FAILED] Failed URL:`, audioUrl);

        // Monitor failed attempts
        monitoring.warn('audio-playback', `Playback failed on attempt ${i + 1}`, {
          context,
          method: isProxied ? 'proxy' : 'direct',
          error: errorMessage,
          errorName: errorName,
          url: originalUrl,
          attemptedUrl: audioUrl
        });

        // Handle specific error types
        if (attemptError instanceof DOMException) {
          if (attemptError.name === 'NotAllowedError') {
            console.log('🚫 [Error Handler] Autoplay blocked - this should not happen on user click');
            // If we get NotAllowedError on a user click, something is wrong
            // Don't show a generic message, return false to let playAlbum handle it
            return false;
          } else if (attemptError.name === 'NotSupportedError') {
            console.log('🚫 [Error Handler] Audio format not supported - trying next URL');
            continue; // Try next URL
          } else if (attemptError.name === 'AbortError') {
            console.log('🚫 [Error Handler] Audio request aborted - trying next URL');
            continue; // Try next URL
          } else if (typeof attemptError.message === 'string' && (attemptError.message.includes('CORS') || attemptError.message.includes('cross-origin'))) {
            console.log('🚫 [Error Handler] CORS error detected - trying next URL');
            continue; // Try next URL
          }
        }

        console.log(`⏳ [Error Handler] Waiting 50ms before trying next URL...`);
        // Add a small delay before trying the next URL (reduced from 150ms for faster skipping)
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    // Clear retry flag
    isRetryingRef.current = false;

    // Set flag to prevent error handler from auto-skipping (we'll handle failure programmatically)
    skipAutoSkipRef.current = true;
    // Clear the flag after a short delay to allow error events to fire
    setTimeout(() => { skipAutoSkipRef.current = false; }, 500);

    return false; // All attempts failed
  };

  // Seamless playback for track transitions - keeps iOS audio session warm
  // by directly swapping source without pause/clear/delay
  const attemptSeamlessPlayback = async (audioUrl: string, context: string, sessionId?: number, mediaType?: string): Promise<boolean> => {
    const isVideo = isVideoUrl(audioUrl, mediaType);
    const currentElement = isVideo ? videoRef.current : audioRef.current;

    if (!currentElement) {
      console.warn('⚠️ No media element for seamless playback');
      return false;
    }

    // Get URLs to try (includes proxied URLs for CORS-problematic domains)
    const urlsToTry = getAudioUrlsToTry(audioUrl);

    for (let i = 0; i < urlsToTry.length; i++) {
      // Check if this session is still current before each attempt
      if (sessionId !== undefined && playbackSessionRef.current !== sessionId) {
        console.log(`⏭️ Seamless session ${sessionId} cancelled, newer session ${playbackSessionRef.current} active`);
        return false;
      }

      let secureUrl = urlsToTry[i];

      // Upgrade HTTP to HTTPS
      if (secureUrl.startsWith('http://')) {
        secureUrl = secureUrl.replace(/^http:/, 'https:');
      }

      try {
        const isProxied = secureUrl.includes('proxy-audio');
        console.log(`🔄 Attempting seamless playback (${i + 1}/${urlsToTry.length}): ${context} - ${isProxied ? 'PROXY' : 'DIRECT'}`);

        // Direct source swap - no pause, no clearing, minimal delay
        // This keeps the audio session "warm" on iOS
        currentElement.src = secureUrl;
        currentElement.load(); // Required on iOS Safari to properly initialize new source

        // Reset currentTime to 0 for iOS - the src change may not automatically reset it
        currentElement.currentTime = 0;

        // Attempt immediate play
        const playPromise = currentElement.play();
        if (playPromise !== undefined) {
          await playPromise;
          console.log(`✅ Seamless playback started: ${context}`);
          return true;
        }
        return true;
      } catch (error) {
        console.warn(`⚠️ Seamless playback attempt ${i + 1} failed: ${error}`);
        // Continue to next URL if available
      }
    }

    console.warn(`⚠️ Seamless playback failed after ${urlsToTry.length} attempts, will fall back`);

    // Set flag to prevent error handler from auto-skipping (we'll handle failure programmatically)
    skipAutoSkipRef.current = true;
    setTimeout(() => { skipAutoSkipRef.current = false; }, 500);

    return false;
  };

  // Media event listeners
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;

    const handlePlay = () => {
      setIsPlaying(true);
      // Update media session playback state immediately for iOS
      if ('mediaSession' in navigator && navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'playing';
      }
      // Publish NIP-38 "now playing" status
      publishNip38StatusDebounced('play');
    };

    const handlePause = () => {
      // Check if this pause is due to track ending naturally
      // On iOS, the 'pause' event fires before/with 'ended' event
      // We need to keep isPlaying true so seamless playback works for next track
      const currentElement = isVideoMode ? video : audio;
      if (currentElement.ended) {
        console.log('🎵 Pause event ignored - track ended naturally, handleEnded will handle transition');
        return;
      }

      // Check if this is an unexpected pause (not user-initiated)
      // Could be caused by network stall, buffer underflow, etc.
      if (!userInitiatedPauseRef.current && currentElement.currentTime > 0 && !currentElement.ended) {
        console.log('⚠️ Unexpected pause detected at', currentElement.currentTime.toFixed(1), 's - attempting recovery');

        // Try to resume after a short delay
        setTimeout(() => {
          // Double-check conditions still apply
          if (!userInitiatedPauseRef.current && currentElement.paused && !currentElement.ended) {
            console.log('🔧 Attempting auto-resume after unexpected pause');
            currentElement.play().catch(err => {
              console.warn('⚠️ Auto-resume failed:', err);
              // If auto-resume fails, let it stay paused and update state
              setIsPlaying(false);
              if ('mediaSession' in navigator && navigator.mediaSession) {
                navigator.mediaSession.playbackState = 'paused';
              }
            });
            return; // Don't update state yet - wait to see if play() succeeds
          }
        }, 500);

        // Don't update isPlaying yet - give auto-resume a chance
        return;
      }

      setIsPlaying(false);
      // Update media session playback state immediately for iOS
      if ('mediaSession' in navigator && navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'paused';
      }
      // NIP-38 status persists - shows last/current track
    };

    const handleEnded = async () => {
      console.log('🎵 Track ended, attempting to play next track');

      // CRITICAL for iOS PWA: Set auto-transitioning flag so playAlbum uses seamless playback
      // This flag ensures seamless playback is used even if isPlaying state has changed
      isAutoTransitioningRef.current = true;

      // CRITICAL for iOS PWA: Keep audio session warm by maintaining 'playing' state
      // before triggering next track. This prevents iOS from releasing the audio session.
      if ('mediaSession' in navigator && navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'playing';
      }

      // Start silent keepalive during track transition on iOS (especially important in background)
      if (isInBackgroundRef.current) {
        startSilentKeepalive();
      }

      // Auto-boost: fire and forget - doesn't block next track (disabled in radio mode)
      // Check settings and trigger boost for the just-finished track
      if (!radioMode && settings.autoBoostEnabled && currentPlayingAlbum && currentTrackIndex >= 0) {
        const track = currentPlayingAlbum.tracks[currentTrackIndex];
        if (track && triggerAutoBoostRef.current) {
          // Fire and forget - don't await
          triggerAutoBoostRef.current(track, currentPlayingAlbum, settings.autoBoostAmount || 50);
        }
      }

      try {
        // Immediately trigger next track without delay for better mobile performance
        // Use the ref to get the latest playNextTrack function
        if (playNextTrackRef.current) {
          // Call playNextTrack synchronously to avoid mobile browser throttling
          playNextTrackRef.current();
        } else {
          console.warn('⚠️ playNextTrackRef.current is null');
        }
      } catch (error) {
        console.error('❌ Error in auto-play:', error);
        // Don't let errors in auto-play crash the application
        isAutoTransitioningRef.current = false;
        setIsPlaying(false);
        if ('mediaSession' in navigator && navigator.mediaSession) {
          navigator.mediaSession.playbackState = 'paused';
        }
        // Stop keepalive if track transition failed
        stopSilentKeepalive();
      }
    };

    const handleTimeUpdate = () => {
      const currentElement = isVideoMode ? video : audio;
      setCurrentTime(currentElement.currentTime);

      // Update position state for iOS lockscreen controls
      if ('mediaSession' in navigator && navigator.mediaSession && isPlaying) {
        if (currentElement.duration && !isNaN(currentElement.duration)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: currentElement.duration,
              playbackRate: currentElement.playbackRate || 1.0,
              position: currentElement.currentTime
            });
          } catch (error) {
            // Ignore errors - some browsers don't support this
          }
        }
      }

      // Check if current track has end time and we've reached it
      if (currentPlayingAlbum && currentPlayingAlbum.tracks[currentTrackIndex]) {
        const track = currentPlayingAlbum.tracks[currentTrackIndex];
        if (track.endTime && typeof track.endTime === 'number') {
          if (currentElement.currentTime >= track.endTime) {
            console.log(`🎵 Reached end time: ${track.endTime}s for track: ${track.title}`);
            // Trigger the ended event to play next track
            currentElement.dispatchEvent(new Event('ended'));
          }
        }

        // Preload next track when we're close to the end (last 5 seconds)
        // This helps mobile devices prepare for smooth transitions
        const timeRemaining = (track.endTime || currentElement.duration) - currentElement.currentTime;
        if (timeRemaining > 0 && timeRemaining <= 5 && !currentElement.paused) {
          // Get next track info
          let nextTrack = null;
          if (isShuffleMode && shuffledPlaylist.length > 0) {
            const nextShuffleIndex = currentShuffleIndex + 1;
            if (nextShuffleIndex < shuffledPlaylist.length) {
              nextTrack = shuffledPlaylist[nextShuffleIndex]?.track;
            } else if (shuffledPlaylist.length > 0) {
              nextTrack = shuffledPlaylist[0]?.track;
            }
          } else if (currentTrackIndex + 1 < currentPlayingAlbum.tracks.length) {
            nextTrack = currentPlayingAlbum.tracks[currentTrackIndex + 1];
          } else if (repeatMode === 'all' && currentPlayingAlbum.tracks.length > 0) {
            nextTrack = currentPlayingAlbum.tracks[0];
          }

          // Preload next track to ensure smooth mobile playback
          if (nextTrack && (nextTrack.url || nextTrack.alternateEnclosures?.length > 0)) {
            const nextTrackUrl = getTrackPlaybackUrl(nextTrack);
            const nextElement = isVideoUrl(nextTrackUrl, nextTrack.mediaType) ? videoRef.current : audioRef.current;
            if (nextElement && nextElement !== currentElement) {
              // Use URL strategy to get the best URL (proxy for CORS-problematic domains)
              const urlsToTry = getAudioUrlsToTry(nextTrackUrl);
              let secureNextUrl = urlsToTry[0] || nextTrackUrl;

              // Upgrade HTTP to HTTPS for preloaded tracks
              if (secureNextUrl.startsWith('http://')) {
                secureNextUrl = secureNextUrl.replace(/^http:/, 'https:');
              }

              // Only preload if not already loaded
              if (!nextElement.src || nextElement.src !== secureNextUrl) {
                console.log('🔄 Preloading next track for smooth transition:', nextTrack.title);
                nextElement.src = secureNextUrl;
                nextElement.preload = 'auto';
                nextElement.load();
              }
            }
          }
        }
      }
    };

    const handleLoadedMetadata = () => {
      const currentElement = isVideoMode ? video : audio;
      setDuration(currentElement.duration);

      // Re-update media session with duration info for iOS
      if (currentPlayingAlbum && currentPlayingAlbum.tracks[currentTrackIndex]) {
        const track = currentPlayingAlbum.tracks[currentTrackIndex];
        updateMediaSession(currentPlayingAlbum, track);

        // Check if current track has time segment information and seek to start time
        if (track.startTime && typeof track.startTime === 'number') {
          // Validate start time against duration
          if (track.startTime < currentElement.duration) {
            console.log(`🎵 Seeking to start time: ${track.startTime}s for track: ${track.title}`);
            currentElement.currentTime = track.startTime;
          } else {
            console.warn(`⚠️ Start time ${track.startTime}s is beyond track duration ${currentElement.duration}s for track: ${track.title}`);
          }
        } else {
          // No startTime - ensure we start from the beginning
          // This is important for iOS where currentTime may not reset automatically on source change
          if (currentElement.currentTime > 1) {
            console.log(`🎵 Resetting currentTime from ${currentElement.currentTime}s to 0 for track: ${track.title}`);
            currentElement.currentTime = 0;
          }
        }
      }
    };

    const handleError = (event: Event) => {
      const mediaError = (event.target as HTMLMediaElement)?.error;
      console.error(`🚫 ${isVideoMode ? 'Video' : 'Audio'} error:`, mediaError);

      // Don't interfere if we're in the middle of retrying
      if (isRetryingRef.current) {
        console.log('🔄 Error during retry process - letting retry logic handle it');
        return;
      }

      setIsPlaying(false);

      // Don't clear the source immediately - let the retry logic in attemptAudioPlayback handle it
      // Only log the error for debugging
      if (mediaError?.code === 4) {
        console.log('🔄 Media not suitable error - retry logic will handle this');
      } else if (mediaError?.code === 3) {
        console.log('🔄 Decode error - retry logic will handle this');
      } else if (mediaError?.code === 2) {
        console.log('🔄 Network error - retry logic will handle this');
      } else if (mediaError?.code === 1) {
        console.log('🔄 Aborted error - retry logic will handle this');
      }

      // Auto-skip to next track on error (especially important for shuffle mode)
      // This prevents playback from stopping when a track fails
      // BUT: Skip if the failure is being handled programmatically (e.g., retry logic completed)
      if (skipAutoSkipRef.current) {
        console.log('⏭️ Skipping auto-skip: failure being handled programmatically');
        return;
      }

      if (playNextTrackRef.current) {
        const currentSession = playbackSessionRef.current;
        console.log(`⏭️ Auto-skipping to next track after error (session ${currentSession})`);
        // Cancel any existing pending auto-skip before scheduling a new one
        cancelPendingAutoSkip();
        autoSkipTimeoutRef.current = setTimeout(() => {
          autoSkipTimeoutRef.current = null;
          // Only auto-skip if no new session started (i.e., user hasn't manually skipped)
          if (playbackSessionRef.current === currentSession && playNextTrackRef.current) {
            playNextTrackRef.current();
          } else {
            console.log(`⏭️ Skipping auto-skip: session changed from ${currentSession} to ${playbackSessionRef.current}`);
          }
        }, 300); // Reduced from 1000ms for faster skipping on CORS/unavailable tracks
      }
    };

    // iOS-specific: Handle stalled event - iOS fires this when buffering
    // Without this handler, iOS may pause playback and not resume
    const handleStalled = (event: Event) => {
      const element = event.target as HTMLMediaElement;
      console.log('⏸️ Media stalled (buffering) - iOS may need help resuming');

      // If we're supposed to be playing, try to resume
      // Check readyState: 4 = HAVE_ENOUGH_DATA, 3 = HAVE_FUTURE_DATA
      if (!element.paused && element.readyState >= 3) {
        console.log('🔄 Stalled but have data - attempting to continue playback');
        element.play().catch(err => {
          console.warn('⚠️ Failed to resume after stall:', err);
        });
      }
    };

    // iOS-specific: Handle waiting event - playback stopped due to lack of data
    const handleWaiting = (event: Event) => {
      const element = event.target as HTMLMediaElement;
      console.log('⏳ Media waiting for data (buffering)');

      // This is informational - playback should auto-resume when data is available
      // But on iOS, sometimes it doesn't, so we'll set a timeout to check
      setTimeout(() => {
        if (element.paused && element.readyState >= 3 && !element.ended) {
          console.log('🔄 Waiting timeout - attempting to resume playback');
          element.play().catch(err => {
            console.warn('⚠️ Failed to resume after waiting:', err);
          });
        }
      }, 1000);
    };

    // Add event listeners to both audio and video elements
    const elements = [audio, video];
    elements.forEach(element => {
      element.addEventListener('play', handlePlay);
      element.addEventListener('pause', handlePause);
      element.addEventListener('ended', handleEnded);
      element.addEventListener('timeupdate', handleTimeUpdate);
      element.addEventListener('loadedmetadata', handleLoadedMetadata);
      element.addEventListener('error', handleError);
      element.addEventListener('stalled', handleStalled);
      element.addEventListener('waiting', handleWaiting);
    });

    // Cleanup
    return () => {
      elements.forEach(element => {
        element.removeEventListener('play', handlePlay);
        element.removeEventListener('pause', handlePause);
        element.removeEventListener('ended', handleEnded);
        element.removeEventListener('timeupdate', handleTimeUpdate);
        element.removeEventListener('loadedmetadata', handleLoadedMetadata);
        element.removeEventListener('error', handleError);
        element.removeEventListener('stalled', handleStalled);
        element.removeEventListener('waiting', handleWaiting);
      });
      
      // Clean up HLS instance - but NOT if:
      // 1. We're in the middle of initializing HLS
      // 2. Video is currently playing (don't destroy active HLS stream)
      const videoElement = videoRef.current;
      const isVideoPlaying = videoElement && !videoElement.paused && !videoElement.ended;

      if (hlsRef.current && !isInitializingHlsRef.current && !isVideoPlaying) {
        console.log('🧹 Cleaning up HLS instance in useEffect cleanup');
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      // Skip cleanup silently if HLS is initializing or video is playing
    };
  }, [isVideoMode, currentPlayingAlbum, currentTrackIndex, isShuffleMode, shuffledPlaylist, currentShuffleIndex, repeatMode, publishNip38StatusDebounced]); // Add necessary dependencies for preloading logic

  // Silent stall detection and recovery
  // Detects when audio element says "playing" but currentTime stops advancing
  useEffect(() => {
    // Only run when we think we're playing
    if (!isPlaying) {
      // Clear any existing interval when not playing
      if (stallCheckIntervalRef.current) {
        clearInterval(stallCheckIntervalRef.current);
        stallCheckIntervalRef.current = null;
      }
      // Reset counters
      staleTimeCounterRef.current = 0;
      recoveryAttemptRef.current = 0;
      return;
    }

    const checkForStall = () => {
      const currentElement = isVideoMode ? videoRef.current : audioRef.current;
      if (!currentElement) return;

      // Only check if we think we're playing AND element is not paused AND not ended
      if (!isPlaying || currentElement.paused || currentElement.ended) {
        // Reset stale counter since we're legitimately not playing
        staleTimeCounterRef.current = 0;
        return;
      }

      const currentElementTime = currentElement.currentTime;
      const lastTime = lastKnownTimeRef.current;

      // Check if time has advanced (threshold of 0.1s to account for precision)
      if (Math.abs(currentElementTime - lastTime) < 0.1) {
        // Time hasn't advanced - increment stale counter
        staleTimeCounterRef.current++;
        console.log(`⚠️ Stall check: time stale for ${staleTimeCounterRef.current * 2}s (${currentElementTime.toFixed(1)}s)`);

        // Trigger recovery after 3 consecutive stale checks (6 seconds)
        if (staleTimeCounterRef.current >= 3) {
          attemptStallRecovery(currentElement, currentElementTime);
        }
      } else {
        // Time is advancing - reset counters
        if (staleTimeCounterRef.current > 0) {
          console.log('✅ Playback resumed naturally');
        }
        staleTimeCounterRef.current = 0;
        recoveryAttemptRef.current = 0;
      }

      // Update last known time
      lastKnownTimeRef.current = currentElementTime;
    };

    const attemptStallRecovery = async (element: HTMLMediaElement, stallTime: number) => {
      const attempt = ++recoveryAttemptRef.current;
      const currentSession = playbackSessionRef.current;

      console.log(`🔧 Stall recovery attempt ${attempt} at ${stallTime.toFixed(1)}s`);

      // Prevent infinite loops - max 4 recovery attempts
      if (attempt > 4) {
        console.log('⏭️ Max recovery attempts reached, auto-skipping to next track');
        recoveryAttemptRef.current = 0;
        staleTimeCounterRef.current = 0;
        if (playNextTrackRef.current && playbackSessionRef.current === currentSession) {
          playNextTrackRef.current();
        }
        return;
      }

      try {
        if (attempt === 1) {
          // Attempt 1: Simple resume
          console.log('🔧 Recovery: Attempting simple resume');
          await element.play();
        } else if (attempt === 2) {
          // Attempt 2: Seek nudge - move forward slightly to unstick decoder
          console.log('🔧 Recovery: Attempting seek nudge');
          element.currentTime = stallTime + 0.1;
          await element.play();
        } else if (attempt === 3) {
          // Attempt 3: Reload at position
          console.log('🔧 Recovery: Attempting source reload');
          const savedTime = element.currentTime;
          element.load();
          element.currentTime = savedTime;
          await element.play();
        } else if (attempt === 4) {
          // Attempt 4: Skip to next track
          console.log('⏭️ Recovery: Skipping to next track');
          recoveryAttemptRef.current = 0;
          staleTimeCounterRef.current = 0;
          if (playNextTrackRef.current && playbackSessionRef.current === currentSession) {
            playNextTrackRef.current();
          }
        }

        // Reset stale counter after recovery attempt (give it a chance)
        staleTimeCounterRef.current = 0;
      } catch (error) {
        console.warn(`⚠️ Recovery attempt ${attempt} failed:`, error);
        // Let next check cycle try next recovery method
      }
    };

    // Start the stall check interval (every 2 seconds)
    stallCheckIntervalRef.current = setInterval(checkForStall, 2000);

    // Initialize last known time
    const currentElement = isVideoMode ? videoRef.current : audioRef.current;
    if (currentElement) {
      lastKnownTimeRef.current = currentElement.currentTime;
    }

    // Cleanup
    return () => {
      if (stallCheckIntervalRef.current) {
        clearInterval(stallCheckIntervalRef.current);
        stallCheckIntervalRef.current = null;
      }
    };
  }, [isPlaying, isVideoMode]);

  // Helper function to proxy external image URLs for media session
  const getProxiedMediaImageUrl = (imageUrl: string): string => {
    if (!imageUrl) return '/stablekraft-rocket.png';

    // If it's already a local/proxied URL, return as-is
    if (imageUrl.startsWith('/') || imageUrl.includes('/api/proxy-image')) {
      return imageUrl;
    }

    // Proxy external URLs to avoid CORS issues
    return `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
  };

  // Helper function to update media session metadata
  const updateMediaSession = (album: RSSAlbum, track: any) => {
    if ('mediaSession' in navigator && navigator.mediaSession) {
      try {
        // Ensure we have valid artwork URL - prefer track image, then album cover
        let originalArtworkUrl = track.image || album.coverArt || '/stablekraft-rocket.png';

        // Proxy external URLs to avoid CORS issues
        let artworkUrl = getProxiedMediaImageUrl(originalArtworkUrl);

        // If the URL is relative, make it absolute
        if (artworkUrl.startsWith('/')) {
          const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://stablekraft.app';
          artworkUrl = `${baseUrl}${artworkUrl}`;
        }
        
        // Create artwork array with various sizes
        const artworkSizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
        const artwork = artworkSizes.map(size => ({
          src: artworkUrl,
          sizes: size,
          type: 'image/jpeg'
        }));
        
        // Also add a catch-all for any size
        artwork.push({
          src: artworkUrl,
          sizes: 'any',
          type: 'image/jpeg'
        });
        
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'Unknown Track',
          artist: album.artist || 'Unknown Artist',
          album: album.title || 'Unknown Album',
          artwork: artwork
        });

        // NOTE: Action handlers are registered ONCE in early init useEffect
        // We don't re-register them here to avoid issues on iOS where
        // re-registering can cause stale closures or handler conflicts

        // Set position state (required for iOS lockscreen controls)
        const currentElement = isVideoMode ? videoRef.current : audioRef.current;
        if (currentElement && currentElement.duration && !isNaN(currentElement.duration)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: currentElement.duration,
              playbackRate: currentElement.playbackRate || 1.0,
              position: currentElement.currentTime || 0
            });
          } catch (error) {
            console.warn('Failed to set position state:', error);
          }
        }

        // Note: playbackState is now managed by handlePlay/handlePause event handlers
        // to avoid race conditions with state updates
        
        console.log('📱 Media session metadata updated:', {
          title: track.title,
          artist: album.artist,
          album: album.title,
          originalArtwork: originalArtworkUrl,
          proxiedArtwork: artworkUrl,
          playbackState: navigator.mediaSession.playbackState
        });
      } catch (error) {
        console.warn('Failed to update media session:', error);
      }
    }
  };

  // Update media session ref for iOS keepalive to re-assert metadata
  useEffect(() => {
    updateMediaSessionRef.current = () => {
      if (currentPlayingAlbum && currentPlayingAlbum.tracks[currentTrackIndex]) {
        updateMediaSession(currentPlayingAlbum, currentPlayingAlbum.tracks[currentTrackIndex]);
      }
    };
  }, [currentPlayingAlbum, currentTrackIndex, isVideoMode]);

  // Play album function
  const playAlbum = async (album: RSSAlbum, trackIndex: number = 0): Promise<boolean> => {
    if (!album.tracks || album.tracks.length === 0) {
      console.error('❌ No tracks found in album');
      return false;
    }

    const track = album.tracks[trackIndex];
    if (!track || !track.url) {
      console.error('❌ No valid track found at index', trackIndex);
      return false;
    }

    // Set loading state immediately for UI feedback
    setIsLoading(true);

    // Increment session ID to cancel any stale playback attempts
    const sessionId = ++playbackSessionRef.current;
    // Cancel any pending auto-skip from previous track failures
    cancelPendingAutoSkip();
    // Reset stall detection counters for new track
    staleTimeCounterRef.current = 0;
    recoveryAttemptRef.current = 0;
    userInitiatedPauseRef.current = false; // New track = not user-paused
    console.log(`🎵 Starting playback session ${sessionId}`);

    // Since playAlbum is called from user clicks, we can safely set hasUserInteracted
    if (!hasUserInteracted) {
      console.log('🎵 First user interaction detected - enabling audio');
      setHasUserInteracted(true);
    }

    // IMPORTANT: Update state BEFORE attempting playback
    // This ensures NIP-38 status publishing has access to correct track info
    setCurrentPlayingAlbum(album);
    setCurrentTrackIndex(trackIndex);

    // Reset currentTime immediately when switching tracks to avoid stale time showing in UI
    // This is especially important on iOS where timeupdate events may be delayed
    const startTime = track.startTime && typeof track.startTime === 'number' ? track.startTime : 0;
    setCurrentTime(startTime);

    // When manually playing an album/track, always exit shuffle mode
    // This ensures shuffle is turned off when you play something specific
    setIsShuffleMode(false);
    setShuffledPlaylist([]);
    setCurrentShuffleIndex(0);

    // Detect if this is a track transition (same album, different track while playing)
    // This is critical for iOS PWA background playback
    // Also check isAutoTransitioningRef for when track ended naturally (iOS fires pause before ended)
    const isTrackTransition = (currentPlayingAlbum?.id === album.id &&
                               currentTrackIndex !== trackIndex &&
                               isPlaying) || isAutoTransitioningRef.current;

    if (isTrackTransition) {
      console.log('🔄 Track transition detected, using seamless playback for iOS', {
        isPlaying,
        isAutoTransitioning: isAutoTransitioningRef.current
      });
      // Try seamless playback first for iOS background compatibility
      const seamlessSuccess = await attemptSeamlessPlayback(getTrackPlaybackUrl(track), 'Track transition', sessionId, track.mediaType);
      // Clear auto-transitioning flag after attempt
      isAutoTransitioningRef.current = false;
      if (seamlessSuccess) {
        // Check if session is still current before updating state
        if (playbackSessionRef.current !== sessionId) {
          console.log(`⏭️ Session ${sessionId} completed but newer session active, skipping state update`);
          return false;
        }
        setIsLoading(false); // Clear loading on success
        updateMediaSession(album, track);
        console.log('✅ Seamless track transition successful');
        return true;
      }
      // If seamless fails, fall through to normal playback
      console.log('⚠️ Seamless playback failed, trying full playback');
    }

    // Clear auto-transitioning flag before full playback attempt
    isAutoTransitioningRef.current = false;

    // Try to play the track (full playback for fresh starts or fallback)
    const success = await attemptAudioPlayback(getTrackPlaybackUrl(track), 'Album playback', sessionId, track.mediaType);

    // Check if session is still current before updating state
    if (playbackSessionRef.current !== sessionId) {
      console.log(`⏭️ Session ${sessionId} completed but newer session active, skipping state update`);
      return false;
    }

    // Clear loading state
    setIsLoading(false);

    if (success) {
      // Update media session for lockscreen display
      updateMediaSession(album, track);

      console.log('✅ Playback started successfully');
      return true;
    } else {
      // Only show retry message if it's a browser autoplay restriction
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      if (isMobile) {
        console.log('📱 Mobile playback failed - may need another tap');
        toast.info('Tap the play button once more to enable audio', { duration: 3000 });
      }
      return false;
    }
  };

  // Play shuffled track function
  const playShuffledTrack = async (index: number): Promise<boolean> => {
    if (!shuffledPlaylist[index]) {
      console.error('❌ Invalid shuffle track index:', index, 'playlist length:', shuffledPlaylist.length);
      return false;
    }

    const trackData = shuffledPlaylist[index];
    const track = trackData.track;
    const album = trackData.album;

    if (!track || !track.url) {
      console.error('❌ No valid track found in shuffled playlist');
      return false;
    }

    // Increment session ID to cancel any stale playback attempts
    const sessionId = ++playbackSessionRef.current;
    // Cancel any pending auto-skip from previous track failures
    cancelPendingAutoSkip();
    console.log(`🎵 Starting shuffle playback session ${sessionId}`);

    // IMPORTANT: Update state BEFORE attempting playback
    setCurrentPlayingAlbum(album);
    setCurrentTrackIndex(trackData.trackIndex);
    setCurrentShuffleIndex(index);
    setHasUserInteracted(true);

    // Reset currentTime immediately when switching tracks to avoid stale time showing in UI
    const startTime = track.startTime && typeof track.startTime === 'number' ? track.startTime : 0;
    setCurrentTime(startTime);

    // In shuffle mode, if we're playing or auto-transitioning, use seamless playback for iOS background
    if (isPlaying || isAutoTransitioningRef.current) {
      console.log('🔄 Shuffle track transition, using seamless playback for iOS', {
        isPlaying,
        isAutoTransitioning: isAutoTransitioningRef.current
      });
      const seamlessSuccess = await attemptSeamlessPlayback(getTrackPlaybackUrl(track), 'Shuffle track transition', sessionId, track.mediaType);
      // Clear auto-transitioning flag after attempt
      isAutoTransitioningRef.current = false;
      if (seamlessSuccess) {
        // Check if session is still current before updating state
        if (playbackSessionRef.current !== sessionId) {
          console.log(`⏭️ Session ${sessionId} completed but newer session active, skipping state update`);
          return false;
        }
        updateMediaSession(album, track);
        console.log('✅ Seamless shuffle transition successful');
        return true;
      }
      console.log('⚠️ Seamless playback failed, trying full playback');
    }

    const success = await attemptAudioPlayback(getTrackPlaybackUrl(track), 'Shuffled track playback', sessionId, track.mediaType);
    // Check if session is still current before updating state
    if (playbackSessionRef.current !== sessionId) {
      console.log(`⏭️ Session ${sessionId} completed but newer session active, skipping state update`);
      return false;
    }
    if (success) {
      // Update media session for lockscreen display
      updateMediaSession(album, track);
    }
    return success;
  };

  // Shuffle all tracks function
  const shuffleAllTracks = async (): Promise<boolean> => {
    // Wait for albums to load if they haven't yet (race condition fix)
    if (albums.length === 0) {
      // Check if albums are still loading (ref not set yet means loading in progress)
      if (!albumsLoadedRef.current) {
        console.log('⏳ Waiting for albums to load before shuffle...');
        // Wait up to 5 seconds for albums to load
        for (let i = 0; i < 50; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (albums.length > 0 || albumsLoadedRef.current) {
            break;
          }
        }
      }
      // Check again after waiting
      if (albums.length === 0) {
        console.warn('No albums available for shuffle after waiting');
        return false;
      }
    }

    // Clear any existing shuffle state to ensure a fresh random shuffle
    // This prevents the same order from being restored from IndexedDB
    setShuffledPlaylist([]);
    setCurrentShuffleIndex(0);
    setIsShuffleMode(false);
    if (typeof window !== 'undefined') {
      storage.removeItem('audioPlayerState');
    }

    // Create a flat array of all tracks with their album info
    const allTracks: Array<{
      album: RSSAlbum;
      trackIndex: number;
      track: any;
    }> = [];

    let skippedPlaylists = 0;
    let skippedTracks = 0;
    let includedAlbums = 0;

    albums.forEach(album => {
      // Skip playlist albums from global shuffle (playlists have feedId ending with '-playlist')
      if (album.feedId?.endsWith('-playlist')) {
        skippedPlaylists++;
        return;
      }
      includedAlbums++;
      if (album.tracks && album.tracks.length > 0) {
        album.tracks.forEach((track, trackIndex) => {
          // Skip tracks without valid audio URLs
          if (!track.url || track.url === '' || track.url.endsWith('.xml') || track.url.endsWith('/feed')) {
            skippedTracks++;
            return;
          }
          allTracks.push({
            album,
            trackIndex,
            track
          });
        });
      }
    });

    console.log(`🎲 Shuffle pool: ${includedAlbums} albums, ${allTracks.length} playable tracks (skipped ${skippedPlaylists} playlists, ${skippedTracks} tracks without audio URL)`);

    if (allTracks.length === 0) {
      console.warn('No tracks available for shuffle');
      return false;
    }

    // Simple Fisher-Yates shuffle - pure random
    const shuffledTracks = [...allTracks];
    for (let i = shuffledTracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledTracks[i], shuffledTracks[j]] = [shuffledTracks[j], shuffledTracks[i]];
    }

    console.log(`🎲 Random shuffle: ${shuffledTracks.length} tracks`);

    // Set up shuffle state
    setShuffledPlaylist(shuffledTracks);
    setCurrentShuffleIndex(0);
    setIsShuffleMode(true);

    // Play the first track in the shuffled playlist
    const firstTrack = shuffledTracks[0];
    console.log('🎲 Starting shuffle with:', firstTrack.track.title, 'from', firstTrack.album.title);

    // Play the first track directly using the local shuffledTracks array to avoid race condition
    const track = firstTrack.track;
    const album = firstTrack.album;

    if (!track || !track.url) {
      console.error('❌ No valid track found in shuffled playlist');
      return false;
    }

    // Increment session ID to cancel any stale playback attempts
    const sessionId = ++playbackSessionRef.current;
    // Cancel any pending auto-skip from previous track failures
    cancelPendingAutoSkip();
    console.log(`🎵 Starting shuffleAll playback session ${sessionId}`);

    // IMPORTANT: Update state BEFORE attempting playback
    setCurrentPlayingAlbum(album);
    setCurrentTrackIndex(firstTrack.trackIndex);
    setCurrentShuffleIndex(0);
    setHasUserInteracted(true);

    const success = await attemptAudioPlayback(getTrackPlaybackUrl(track), 'Shuffled track playback', sessionId, track.mediaType);

    // Check if session is still current before updating state
    if (playbackSessionRef.current !== sessionId) {
      console.log(`⏭️ Session ${sessionId} completed but newer session active, skipping state update`);
      return false;
    }

    // If initial track failed, auto-skip to find a playable track
    if (!success) {
      console.log('⏭️ Initial shuffle track failed, auto-skipping to next...');
      const currentSession = playbackSessionRef.current;
      setTimeout(() => {
        // Only auto-skip if no new session started
        if (playbackSessionRef.current === currentSession && playNextTrackRef.current) {
          playNextTrackRef.current();
        }
      }, 500);
      // Return true so caller doesn't show error - we're handling it
      return true;
    }

    // Prefetch upcoming tracks in the background for smooth radio playback
    if (shuffledTracks.length > 1) {
      const upcomingTracks = shuffledTracks.slice(1, 4).map(item => item.track);
      prefetchUpcomingTracks(upcomingTracks, 0).catch(() => {
        // Silent fail - prefetching is best-effort
      });
    }

    return success;
  };

  // Shuffle specific albums (for page-specific shuffle like publisher pages)
  const shuffleAlbums = async (albumsToShuffle: RSSAlbum[]): Promise<boolean> => {
    if (!albumsToShuffle || albumsToShuffle.length === 0) {
      console.warn('No albums provided for shuffle');
      return false;
    }

    // Clear any existing shuffle state to ensure a fresh random shuffle
    setShuffledPlaylist([]);
    setCurrentShuffleIndex(0);
    setIsShuffleMode(false);
    if (typeof window !== 'undefined') {
      storage.removeItem('audioPlayerState');
    }

    // Create a flat array of all tracks with their album info
    const allTracks: Array<{
      album: RSSAlbum;
      trackIndex: number;
      track: any;
    }> = [];

    let skippedTracks = 0;
    albumsToShuffle.forEach(album => {
      if (album.tracks && album.tracks.length > 0) {
        album.tracks.forEach((track, trackIndex) => {
          // Skip tracks without valid audio URLs
          if (!track.url || track.url === '' || track.url.endsWith('.xml') || track.url.endsWith('/feed')) {
            skippedTracks++;
            return;
          }
          allTracks.push({
            album,
            trackIndex,
            track
          });
        });
      }
    });

    console.log(`🎲 Page shuffle pool: ${albumsToShuffle.length} albums, ${allTracks.length} playable tracks (skipped ${skippedTracks} without audio URL)`);

    if (allTracks.length === 0) {
      console.warn('No tracks available for shuffle');
      return false;
    }

    // Simple Fisher-Yates shuffle - pure random
    const shuffledTracks = [...allTracks];
    for (let i = shuffledTracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledTracks[i], shuffledTracks[j]] = [shuffledTracks[j], shuffledTracks[i]];
    }

    console.log(`🎲 Random shuffle: ${shuffledTracks.length} tracks`);

    // Set up shuffle state
    setShuffledPlaylist(shuffledTracks);
    setCurrentShuffleIndex(0);
    setIsShuffleMode(true);

    // Play the first track in the shuffled playlist
    const firstTrack = shuffledTracks[0];
    console.log('🎲 Starting shuffle with:', firstTrack.track.title, 'from', firstTrack.album.title);

    const track = firstTrack.track;
    const album = firstTrack.album;

    if (!track || !track.url) {
      console.error('❌ No valid track found in shuffled playlist');
      return false;
    }

    // Increment session ID to cancel any stale playback attempts
    const sessionId = ++playbackSessionRef.current;
    // Cancel any pending auto-skip from previous track failures
    cancelPendingAutoSkip();
    console.log(`🎵 Starting shuffleAlbums playback session ${sessionId}`);

    // IMPORTANT: Update state BEFORE attempting playback
    setCurrentPlayingAlbum(album);
    setCurrentTrackIndex(firstTrack.trackIndex);
    setCurrentShuffleIndex(0);
    setHasUserInteracted(true);

    const success = await attemptAudioPlayback(getTrackPlaybackUrl(track), 'Shuffled track playback', sessionId, track.mediaType);

    // Check if session is still current before updating state
    if (playbackSessionRef.current !== sessionId) {
      console.log(`⏭️ Session ${sessionId} completed but newer session active, skipping state update`);
      return false;
    }

    // If initial track failed, auto-skip to find a playable track
    if (!success) {
      console.log('⏭️ Initial shuffle track failed, auto-skipping to next...');
      const currentSession = playbackSessionRef.current;
      setTimeout(() => {
        // Only auto-skip if no new session started
        if (playbackSessionRef.current === currentSession && playNextTrackRef.current) {
          playNextTrackRef.current();
        }
      }, 500);
      return true;
    }

    // Prefetch upcoming tracks in the background for smooth playback
    if (shuffledTracks.length > 1) {
      const upcomingTracks = shuffledTracks.slice(1, 4).map(item => item.track);
      prefetchUpcomingTracks(upcomingTracks, 0).catch(() => {
        // Silent fail - prefetching is best-effort
      });
    }

    return success;
  };

  // Pause function - uses DOM ID as fallback for iOS background reliability
  const pause = () => {
    // Mark this as user-initiated pause so we don't try to auto-recover
    userInitiatedPauseRef.current = true;

    // Try ref first, then fallback to DOM query for iOS background compatibility
    let currentElement: HTMLAudioElement | HTMLVideoElement | null = isVideoMode
      ? videoRef.current
      : audioRef.current;

    // Fallback to DOM query if ref is unavailable (iOS background edge case)
    if (!currentElement) {
      currentElement = isVideoMode
        ? document.getElementById('stablekraft-video-player') as HTMLVideoElement
        : document.getElementById('stablekraft-audio-player') as HTMLAudioElement;
      console.log('📱 Pause: Using DOM fallback, element found:', !!currentElement);
    }

    if (currentElement) {
      currentElement.pause();
      // Update media session playback state
      if ('mediaSession' in navigator && navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'paused';
      }
      console.log('✅ Pause executed successfully');
    } else {
      console.warn('⚠️ Pause: No audio/video element found');
    }
  };

  // Resume function - uses DOM ID as fallback for iOS background reliability
  const resume = () => {
    // Clear user-initiated pause flag since we're resuming
    userInitiatedPauseRef.current = false;

    // Ensure Web Audio context is running (critical for volume normalization)
    ensureWebAudioRunning();

    // Try ref first, then fallback to DOM query for iOS background compatibility
    let currentElement: HTMLAudioElement | HTMLVideoElement | null = isVideoMode
      ? videoRef.current
      : audioRef.current;

    // Fallback to DOM query if ref is unavailable (iOS background edge case)
    if (!currentElement) {
      currentElement = isVideoMode
        ? document.getElementById('stablekraft-video-player') as HTMLVideoElement
        : document.getElementById('stablekraft-audio-player') as HTMLAudioElement;
      console.log('📱 Resume: Using DOM fallback, element found:', !!currentElement);
    }

    if (currentElement) {
      currentElement.play();
      // Update media session playback state
      if ('mediaSession' in navigator && navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'playing';
      }
      console.log('✅ Resume executed successfully');
    } else {
      console.warn('⚠️ Resume: No audio/video element found');
    }
  };

  // Update pause/resume refs for media session handlers
  useEffect(() => {
    pauseRef.current = pause;
  }, [isVideoMode]);

  useEffect(() => {
    resumeRef.current = resume;
  }, [isVideoMode]);

  // Seek function
  const seek = (time: number) => {
    const currentElement = isVideoMode ? videoRef.current : audioRef.current;
    if (currentElement && duration) {
      // Validate time value
      const validTime = Math.max(0, Math.min(time, duration));
      
      // Check if the time is reasonable (not too large)
      if (time > duration * 2) {
        console.warn(`⚠️ Seek time ${time}s is much larger than duration ${duration}s, clamping to duration`);
      }
      
      currentElement.currentTime = validTime;
      setCurrentTime(currentElement.currentTime);
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`🎵 Seeking to time: ${validTime}s (requested: ${time}s, duration: ${duration}s)`);
      }
    } else {
      console.warn('⚠️ Cannot seek: no media element or duration not available');
    }
  };

  // Play next track - moved before useEffect hooks that depend on it
  const playNextTrack = useCallback(async () => {
    console.log('⏭️ playNextTrack called from lockscreen', {
      repeatMode,
      currentTrackIndex,
      totalTracks: currentPlayingAlbum?.tracks?.length || 0,
      isShuffleMode
    });

    // Add state validation and recovery logic
    if (!currentPlayingAlbum || !currentPlayingAlbum.tracks || currentPlayingAlbum.tracks.length === 0) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('⚠️ Cannot play next track: missing album or tracks');
        console.log('🔍 Current state:', {
          hasAlbum: !!currentPlayingAlbum,
          hasTracks: !!(currentPlayingAlbum?.tracks),
          trackCount: currentPlayingAlbum?.tracks?.length || 0,
          currentIndex: currentTrackIndex
        });
      }
      
      // Try to recover from IndexedDB if available
      if (typeof window !== 'undefined') {
        try {
          const savedState = await storage.getItem('audioPlayerState');
          if (savedState) {
            const parsedState = typeof savedState === 'string' ? JSON.parse(savedState) : savedState;
            if (parsedState.currentPlayingAlbum && parsedState.currentPlayingAlbum.tracks) {
              console.log('🔄 Attempting to recover from saved state');
              setCurrentPlayingAlbum(parsedState.currentPlayingAlbum);
              setCurrentTrackIndex(parsedState.currentTrackIndex || 0);
              // Retry after state recovery - using ref to avoid stale closure
              setTimeout(() => {
                if (playNextTrackRef.current) {
                  playNextTrackRef.current();
                }
              }, 100);
              return;
            }
          }
        } catch (error) {
          console.error('❌ Error recovering from IndexedDB:', error);
        }
      }
      
      return;
    }

    if (isShuffleMode && shuffledPlaylist.length > 0) {
      // Handle repeat one mode in shuffle - replay current track
      if (repeatMode === 'one') {
        console.log('🔂 Shuffle: Repeat one mode - replaying current track');
        await playShuffledTrack(currentShuffleIndex);
        return;
      }

      // In shuffle mode, play next track from shuffled playlist
      const nextShuffleIndex = currentShuffleIndex + 1;

      if (nextShuffleIndex < shuffledPlaylist.length) {
        // Play next track in shuffled playlist
        const nextTrack = shuffledPlaylist[nextShuffleIndex];
        console.log('🎲 Playing next shuffled track:', nextTrack.track.title, 'from', nextTrack.album.title);
        const success = await playShuffledTrack(nextShuffleIndex);

        // If playback failed (CORS, unavailable, etc.), auto-skip to next track
        if (!success) {
          console.log('⏭️ Track failed to play, auto-skipping to next...');
          // Cancel any existing pending auto-skip before scheduling a new one
          cancelPendingAutoSkip();
          autoSkipTimeoutRef.current = setTimeout(() => {
            autoSkipTimeoutRef.current = null;
            if (playNextTrackRef.current) {
              playNextTrackRef.current();
            }
          }, 500);
          return;
        }

        // Prefetch upcoming tracks in the background
        const upcomingTracks = shuffledPlaylist.slice(nextShuffleIndex + 1, nextShuffleIndex + 4).map(item => item.track);
        if (upcomingTracks.length > 0) {
          prefetchUpcomingTracks(upcomingTracks, 0).catch(() => {});
        }
      } else {
        // End of shuffled playlist
        if (repeatMode === 'all') {
          // Loop back to the first track
          console.log('🔁 Shuffle: Repeat all - looping back to first track');
          const success = await playShuffledTrack(0);

          // If playback failed, try next track
          if (!success) {
            console.log('⏭️ First track failed to play, trying next...');
            // Cancel any existing pending auto-skip before scheduling a new one
            cancelPendingAutoSkip();
            autoSkipTimeoutRef.current = setTimeout(() => {
              autoSkipTimeoutRef.current = null;
              if (playNextTrackRef.current) {
                playNextTrackRef.current();
              }
            }, 500);
            return;
          }

          // Prefetch upcoming tracks from the start
          const upcomingTracks = shuffledPlaylist.slice(1, 4).map(item => item.track);
          if (upcomingTracks.length > 0) {
            prefetchUpcomingTracks(upcomingTracks, 0).catch(() => {});
          }
        } else {
          // repeatMode === 'none' - stop playback but stay in shuffle mode
          console.log('⏹️ Shuffle: End of playlist reached, stopping playback');
          setIsPlaying(false);
          // Stay in shuffle mode so user can hit play to restart
        }
      }
      return;
    }

    // Normal mode - play next track in current album

    // Handle repeat one mode
    if (repeatMode === 'one') {
      // Replay the same track
      console.log('🔂 Repeat one mode detected - replaying current track');
      await playAlbum(currentPlayingAlbum, currentTrackIndex);
      return;
    }

    // Find the next available (non-unavailable) track
    let nextIndex = currentTrackIndex + 1;
    const totalTracks = currentPlayingAlbum.tracks.length;
    let checkedCount = 0;

    // Skip unavailable tracks
    while (nextIndex < totalTracks && checkedCount < totalTracks) {
      const track = currentPlayingAlbum.tracks[nextIndex];
      if (!track.status || track.status === 'active') {
        break; // Found an available track
      }
      console.log(`⏭️ Skipping unavailable track: ${track.title}`);
      nextIndex++;
      checkedCount++;
    }

    if (nextIndex < totalTracks) {
      // Play next available track in the album
      console.log('🎵 Playing next track:', currentPlayingAlbum.tracks[nextIndex].title, `(${nextIndex + 1}/${totalTracks})`);
      await playAlbum(currentPlayingAlbum, nextIndex);
    } else {
      // End of album reached
      if (repeatMode === 'all') {
        // Loop back to the first available track
        let firstAvailableIndex = 0;
        while (firstAvailableIndex < totalTracks) {
          const track = currentPlayingAlbum.tracks[firstAvailableIndex];
          if (!track.status || track.status === 'active') {
            break;
          }
          firstAvailableIndex++;
        }
        if (firstAvailableIndex < totalTracks) {
          if (process.env.NODE_ENV === 'development') {
            console.log('🔁 Repeat all: looping back to first available track');
          }
          await playAlbum(currentPlayingAlbum, firstAvailableIndex);
        } else {
          // All tracks are unavailable
          console.log('⚠️ All tracks are unavailable, stopping playback');
          setIsPlaying(false);
        }
      } else {
        // repeatMode === 'none' - stop playback
        if (process.env.NODE_ENV === 'development') {
          console.log('⏹️ End of album reached, stopping playback');
        }
        setIsPlaying(false);
        // Optionally reset to first track but don't play
        setCurrentTrackIndex(0);
      }
    }
  }, [currentPlayingAlbum, currentTrackIndex, isShuffleMode, shuffledPlaylist, currentShuffleIndex, playShuffledTrack, playAlbum, repeatMode]);

  // Update the ref whenever playNextTrack changes
  useEffect(() => {
    playNextTrackRef.current = playNextTrack;
  }, [playNextTrack]);

  // Play previous track
  const playPreviousTrack = useCallback(async () => {
    console.log('⏮️ playPreviousTrack called from lockscreen');

    if (isShuffleMode && shuffledPlaylist.length > 0) {
      // In shuffle mode, play previous track from shuffled playlist
      const prevShuffleIndex = currentShuffleIndex - 1;

      if (prevShuffleIndex >= 0) {
        // Play previous track in shuffled playlist
        const prevTrack = shuffledPlaylist[prevShuffleIndex];
        console.log('🎲 Playing previous shuffled track:', prevTrack.track.title, 'from', prevTrack.album.title);
        await playShuffledTrack(prevShuffleIndex);
      } else {
        // Go to the last track in shuffled playlist
        const lastIndex = shuffledPlaylist.length - 1;
        const lastTrack = shuffledPlaylist[lastIndex];
        console.log('🎲 Playing last shuffled track:', lastTrack.track.title, 'from', lastTrack.album.title);
        await playShuffledTrack(lastIndex);
      }
      return;
    }

    // Normal mode - play previous track in current album
    if (!currentPlayingAlbum || !currentPlayingAlbum.tracks) {
      console.warn('⚠️ Cannot play previous track: missing album or tracks');
      return;
    }

    const prevIndex = currentTrackIndex - 1;
    if (prevIndex >= 0) {
      console.log('🎵 Playing previous track:', currentPlayingAlbum.tracks[prevIndex].title);
      await playAlbum(currentPlayingAlbum, prevIndex);
    } else {
      console.log('⚠️ Already at first track');
    }
  }, [isShuffleMode, shuffledPlaylist, currentShuffleIndex, playShuffledTrack, currentPlayingAlbum, currentTrackIndex, playAlbum]);

  // Update the ref whenever playPreviousTrack changes
  useEffect(() => {
    playPreviousTrackRef.current = playPreviousTrack;
  }, [playPreviousTrack]);

  // Play individual track function
  const playTrack = async (audioUrl: string, startTime: number = 0, endTime?: number): Promise<boolean> => {
    console.log('🎵 Playing individual track:', { audioUrl, startTime, endTime });
    
    // Stop any current playback
    stop();
    
    // Set user interaction flag
    setHasUserInteracted(true);
    
    // Create a single-track "album" to enable repeat functionality
    const singleTrackAlbum: RSSAlbum = {
      title: 'Single Track',
      artist: 'Unknown Artist',
      description: '',
      coverArt: null,
      releaseDate: new Date().toISOString(),
      tracks: [{
        title: 'Track',
        url: audioUrl,
        startTime,
        endTime,
        duration: '0' // Will be updated when metadata loads
      }]
    };
    
    // Set the album context so repeat works
    setCurrentPlayingAlbum(singleTrackAlbum);
    setCurrentTrackIndex(0);
    
    // Attempt to play the track
    const success = await attemptAudioPlayback(audioUrl, 'individual track');
    
    if (success && startTime > 0) {
      // Seek to start time after a short delay to ensure media is loaded
      setTimeout(() => {
        console.log('🎵 Seeking to start time:', startTime);
        seek(startTime);
      }, 500);
    }
    
    console.log('🎵 Track playback result:', success);
    return success;
  };

  // Stop function
  const stop = () => {
    // Stop both audio and video elements
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }

    // Clean up HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    // Clear last published NIP-38 track so next play will publish
    lastPublishedNip38TrackRef.current = null;

    setIsPlaying(false);
    setCurrentPlayingAlbum(null);
    setCurrentTrackIndex(0);
    setCurrentTime(0);
    setDuration(0);
    setIsVideoMode(false);

    // Clear shuffle state
    setIsShuffleMode(false);
    setShuffledPlaylist([]);
    setCurrentShuffleIndex(0);

    // Clear IndexedDB
    if (typeof window !== 'undefined') {
      storage.removeItem('audioPlayerState');
    }

    // Don't clear NIP-38 status - it persists as "last played"
  };

  // Toggle shuffle mode
  const toggleShuffle = () => {
    const newShuffleMode = !isShuffleMode;
    setIsShuffleMode(newShuffleMode);

    if (process.env.NODE_ENV === 'development') {
      console.log('🎲 Shuffle mode toggled:', newShuffleMode);
    }

    // When enabling shuffle, create a shuffled playlist from the current album
    if (newShuffleMode && currentPlayingAlbum?.tracks && currentPlayingAlbum.tracks.length > 0) {
      const albumTracks = currentPlayingAlbum.tracks.map((track, trackIndex) => ({
        album: currentPlayingAlbum,
        trackIndex,
        track
      }));

      // Fisher-Yates shuffle
      const shuffled = [...albumTracks];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      // Find current track position in shuffled array and move it to front
      // so playback continues from current track
      const currentTrackIdx = shuffled.findIndex(t => t.trackIndex === currentTrackIndex);
      if (currentTrackIdx > 0) {
        const [currentTrack] = shuffled.splice(currentTrackIdx, 1);
        shuffled.unshift(currentTrack);
      }

      setShuffledPlaylist(shuffled);
      setCurrentShuffleIndex(0);

      console.log(`🎲 Created album shuffle: ${shuffled.length} tracks from "${currentPlayingAlbum.title}"`);
    } else if (!newShuffleMode) {
      // When disabling shuffle, clear the shuffled playlist
      setShuffledPlaylist([]);
      setCurrentShuffleIndex(0);
      console.log('🎲 Cleared shuffle playlist');
    }
  };

  // Memoize setInitialAlbums to prevent recreation on every render
  const setInitialAlbums = useCallback((initialAlbums: RSSAlbum[]) => {
    // Only set if we don't already have albums loaded
    if (!albumsLoadedRef.current && initialAlbums.length > 0) {
      setAlbums(initialAlbums);
      albumsLoadedRef.current = true;
      console.log(`✅ Pre-loaded ${initialAlbums.length} albums from server`);
    }
  }, []);

  // Memoize context value to prevent unnecessary re-renders of consumers
  // Without this, every currentTime update (every second) would re-render all consumers
  const value: AudioContextType = useMemo(() => ({
    currentPlayingAlbum,
    isPlaying,
    isLoading,
    currentTrackIndex,
    currentTime,
    duration,
    isVideoMode,
    isShuffleMode,
    isFullscreenMode,
    setFullscreenMode: setIsFullscreenMode,
    repeatMode,
    setRepeatMode,
    playAlbum,
    playTrack,
    playShuffledTrack,
    shuffleAllTracks,
    shuffleAlbums,
    toggleShuffle,
    pause,
    resume,
    seek,
    playNextTrack,
    playPreviousTrack,
    stop,
    audioRef,
    videoRef,
    setInitialAlbums,
  }), [
    currentPlayingAlbum,
    isPlaying,
    isLoading,
    currentTrackIndex,
    currentTime,
    duration,
    isVideoMode,
    isShuffleMode,
    isFullscreenMode,
    repeatMode,
    playAlbum,
    playTrack,
    playShuffledTrack,
    shuffleAllTracks,
    shuffleAlbums,
    toggleShuffle,
    pause,
    resume,
    seek,
    playNextTrack,
    playPreviousTrack,
    stop,
    setInitialAlbums,
  ]);

  return (
    <AudioContext.Provider value={value}>
      {children}
      {/* Hidden audio element - ID used for iOS background fallback
          Note: Using position absolute off-screen instead of opacity:0/1px
          as some iOS versions don't treat very small elements as real media */}
      <audio
        id="stablekraft-audio-player"
        ref={audioRef}
        preload={isIOS ? 'auto' : 'metadata'}
        playsInline
        webkit-playsinline="true"
        x-webkit-airplay="allow"
        autoPlay={false}
        controls={true}
        muted={false}
        style={{
          position: 'absolute',
          left: '-9999px',
          top: '-9999px',
          width: '1px',
          height: '1px',
          pointerEvents: 'none'
        }}
      />
      {/* Hidden video element - ID used for iOS background fallback */}
      <video
        id="stablekraft-video-player"
        ref={videoRef}
        preload={isIOS ? 'auto' : 'metadata'}
        playsInline
        webkit-playsinline="true"
        x-webkit-airplay="allow"
        autoPlay={false}
        controls={true}
        muted={false}
        style={{
          position: 'absolute',
          left: '-9999px',
          top: '-9999px',
          width: '1px',
          height: '1px',
          pointerEvents: 'none'
        }}
      />
    </AudioContext.Provider>
  );
}; 