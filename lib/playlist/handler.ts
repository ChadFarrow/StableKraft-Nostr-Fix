/**
 * Playlist handler factory
 * Creates Next.js route handlers for playlist endpoints
 */

import { NextResponse } from 'next/server';
import { playlistCache } from '@/lib/playlist-cache';
import { processPlaylistFeedDiscovery } from '@/lib/feed-discovery';
import type { PlaylistConfig, PlaylistAlbum, PlaylistResponse } from './types';
import { fetchAndParsePlaylist } from './parser';
import {
  resolvePlaylistItems,
  buildTracksWithContext,
  buildEpisodeGroups,
  getPlaylistFromDatabase,
  savePlaylistToDatabase
} from './resolver';

/**
 * Create a GET handler for a playlist endpoint
 */
export function createPlaylistHandler(config: PlaylistConfig) {
  return async function GET(request: Request): Promise<NextResponse<PlaylistResponse | { success: false; error: string }>> {
    try {
      console.log(`🎵 Fetching ${config.shortName} playlist...`);

      // Check for force refresh parameter
      const forceRefresh = new URL(request.url).searchParams.has('refresh');

      // FAST PATH: Try database first (instant, no XML fetch needed)
      if (!forceRefresh) {
        const dbResult = await getPlaylistFromDatabase(config);
        if (dbResult.found && dbResult.response) {
          return NextResponse.json(dbResult.response);
        }
      }

      // Check persistent cache
      const cacheKey = `${config.id}-playlist`;
      if (!forceRefresh && playlistCache.isCacheValid(cacheKey, config.cacheDuration)) {
        const cachedData = playlistCache.getCachedData(cacheKey);
        if (cachedData) {
          console.log(`⚡ [${config.shortName}] Using cached playlist data`);
          return NextResponse.json(cachedData);
        }
      }

      // Fetch and parse the playlist XML
      console.log(`📄 [${config.shortName}] Fetching playlist XML...`);
      const { artworkUrl, playlistLink, remoteItems, groupedItems } = await fetchAndParsePlaylist(config.url);

      console.log(`📋 [${config.shortName}] Found ${remoteItems.length} remote items`);
      if (groupedItems.hasEpisodeMarkers) {
        console.log(`📺 [${config.shortName}] Found ${groupedItems.episodes.length} episodes`);
      }

      // Resolve playlist items from database
      console.log(`🔍 [${config.shortName}] Resolving tracks from database...`);
      const resolvedTracks = await resolvePlaylistItems(remoteItems, config);
      console.log(`✅ [${config.shortName}] Resolved ${resolvedTracks.length} tracks`);

      // On refresh, discover and add missing feeds to database
      if (forceRefresh && resolvedTracks.length < remoteItems.length) {
        const resolvedGuids = new Set(resolvedTracks.map(t => t.playlistContext?.itemGuid));
        const unresolvedItems = remoteItems.filter(item => !resolvedGuids.has(item.itemGuid));

        if (unresolvedItems.length > 0) {
          console.log(`🔍 [${config.shortName}] Discovering ${unresolvedItems.length} missing feeds...`);
          try {
            const addedFeeds = await processPlaylistFeedDiscovery(unresolvedItems);
            console.log(`✅ [${config.shortName}] Added ${addedFeeds} new feeds to database`);
          } catch (error) {
            console.warn(`⚠️ [${config.shortName}] Feed discovery error:`, error);
          }
        }
      }

      // Build tracks with episode context and filtering
      const tracks = buildTracksWithContext(remoteItems, resolvedTracks, artworkUrl, config);

      // Build episode groups
      const episodes = buildEpisodeGroups(groupedItems, tracks);

      if (groupedItems.hasEpisodeMarkers) {
        console.log(`📺 [${config.shortName}] Built ${episodes.length} episodes with resolved tracks`);
      }

      // Create the playlist album object
      const playlistAlbum: PlaylistAlbum = {
        id: `${config.id}-playlist`,
        title: config.name,
        artist: 'Various Artists',
        album: config.name,
        description: config.description,
        image: artworkUrl || '/placeholder-podcast.jpg',
        coverArt: artworkUrl || '/placeholder-podcast.jpg',
        url: config.url,
        link: playlistLink,
        tracks: tracks,
        episodes: episodes,
        hasEpisodeMarkers: groupedItems.hasEpisodeMarkers,
        feedId: `${config.id}-playlist`,
        type: 'playlist',
        totalTracks: tracks.length,
        publishedAt: new Date().toISOString(),
        isPlaylistCard: true,
        playlistUrl: config.playlistUrl,
        albumUrl: config.albumUrl,
        playlistContext: {
          source: `${config.id}-playlist`,
          originalUrl: config.url,
          resolvedTracks: resolvedTracks.length,
          totalRemoteItems: remoteItems.length,
          totalEpisodes: episodes.length
        }
      };

      console.log(`✅ [${config.shortName}] Created playlist with ${tracks.length} tracks and ${episodes.length} episodes`);

      const responseData: PlaylistResponse = {
        success: true,
        albums: [playlistAlbum],
        totalCount: 1,
        playlist: {
          title: config.name,
          description: config.description,
          author: config.author,
          totalItems: 1,
          items: [playlistAlbum]
        }
      };

      // Save to database on refresh
      if (forceRefresh) {
        await savePlaylistToDatabase(config, tracks, artworkUrl, playlistLink);
      }

      // Cache the response
      playlistCache.setCachedData(cacheKey, responseData);

      return NextResponse.json(responseData);

    } catch (error) {
      console.error(`❌ [${config.shortName}] Error fetching playlist:`, error);
      return NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        { status: 500 }
      );
    }
  };
}

/**
 * Export maxDuration config helper
 */
export function getMaxDuration(config: PlaylistConfig): number {
  return config.maxDuration;
}
