/**
 * Duration validation utilities for music tracks
 */

// Maximum reasonable duration for a music track (2 hours in seconds)
const MAX_MUSIC_TRACK_DURATION = 7200;

/**
 * Validates and sanitizes duration values for music tracks
 * Returns undefined for obviously corrupted data (e.g., > 2 hours)
 */
export function validateDuration(duration: number | null | undefined, trackTitle?: string): number | undefined {
  if (!duration) return undefined;

  // Filter out non-music content (podcasts, etc.) by duration
  if (duration > MAX_MUSIC_TRACK_DURATION) {
    return undefined;
  }

  return duration;
}
