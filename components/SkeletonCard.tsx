'use client';

/**
 * Skeleton loading card with shimmer animation
 * Used for loading states in album/track grids
 */
export function SkeletonCard() {
  return (
    <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 animate-pulse">
      {/* Album artwork skeleton */}
      <div className="aspect-square bg-gradient-to-br from-gray-800/50 to-gray-700/50 rounded-lg mb-3 relative overflow-hidden">
        {/* Shimmer effect */}
        <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent" />
      </div>
      
      {/* Title skeleton */}
      <div className="h-4 bg-gray-700/50 rounded mb-2 w-4/5 relative overflow-hidden">
        <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent" />
      </div>
      
      {/* Artist skeleton */}
      <div className="h-3 bg-gray-700/50 rounded w-2/3 relative overflow-hidden">
        <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent" />
      </div>
    </div>
  );
}

interface SkeletonGridProps {
  count?: number;
}

/**
 * Grid of skeleton cards
 */
export function SkeletonGrid({ count = 12 }: SkeletonGridProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3 sm:gap-4 md:gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
