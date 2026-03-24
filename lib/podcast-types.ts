/**
 * Canonical type definitions for podcast chapters and value time splits.
 * Single source of truth — import from here instead of defining locally.
 */

export interface PodcastChapter {
  title: string;
  startTime: number;
  endTime?: number;
  img?: string;
}

export interface ValueTimeSplit {
  startTime: number;
  duration: number;
  remotePercentage: number;
  remoteItem?: {
    feedGuid: string;
    itemGuid: string;
  };
}
