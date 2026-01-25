/**
 * Common TypeScript types used across the application
 * Reduces usage of 'any' and improves type safety
 */

// Filter and View Types
export type FilterType = 'all' | 'albums' | 'eps' | 'singles' | 'publishers' | 'playlist' | 'videos';
export type ViewType = 'grid' | 'list';
export type SortType = 'name' | 'date' | 'artist';

// Publisher Types
export interface Publisher {
  id: string;
  title: string;
  description?: string;
  image?: string;
  feedGuid?: string;
  originalUrl?: string;
  itemCount?: number;
  totalTracks?: number;
}

// Album Types (extended from RSSAlbum)
export interface AlbumWithMeta {
  id: string;
  feedId?: string;
  feedGuid?: string;
  title: string;
  artist: string;
  description?: string;
  coverArt?: string;
  releaseDate: string;
  tracks: TrackWithMeta[];
  albumCount?: number;
  totalTracks?: number;
  isPlaylistCard?: boolean;
  isPublisherCard?: boolean;
  publisherUrl?: string;
  playlistUrl?: string;
}

export interface TrackWithMeta {
  id?: string;
  title: string;
  artist?: string;
  duration: string;
  url: string;
  trackNumber?: number;
  subtitle?: string;
  summary?: string;
  image?: string;
  explicit?: boolean;
  keywords?: string[];
  v4vRecipient?: any; // Complex V4V type
  v4vValue?: any; // Complex V4V type
  guid?: string;
  startTime?: number;
  endTime?: number;
  mediaType?: 'audio' | 'video';
  alternateEnclosures?: any[];
}

// API Response Types
export interface PaginatedResponse<T> {
  albums: T[];
  totalCount: number;
  hasMore?: boolean;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// Loading States
export interface LoadingState {
  isLoading: boolean;
  error: string | null;
  progress?: number;
}

// Filter Cache Type
export interface FilterCacheData {
  albums: AlbumWithMeta[];
  totalCount: number;
  hasMore: boolean;
}

// Format Counts for Progressive Loading
export interface FormatCounts {
  albums: number;
  eps: number;
  singles: number;
}

// Playlist Types
export interface PlaylistConfig {
  id: string;
  title: string;
  description: string;
  apiEndpoint: string;
  imageUrl?: string;
}

// Share Data
export interface ShareData {
  url?: string;
  title?: string;
  text?: string;
}

// Keyboard Shortcut
export interface KeyboardShortcut {
  key: string;
  action: string;
  handler: () => void;
}
