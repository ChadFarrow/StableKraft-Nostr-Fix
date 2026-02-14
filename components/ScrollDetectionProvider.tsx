'use client';

import { useScrollDetection } from '@/hooks/useScrollDetection';
import { createContext, useContext, useMemo, ReactNode } from 'react';

interface ScrollDetectionContextType {
  isScrolling: boolean;
  shouldPreventClick: () => boolean;
}

const ScrollDetectionContext = createContext<ScrollDetectionContextType>({
  isScrolling: false,
  shouldPreventClick: () => false
});

export const useScrollDetectionContext = () => useContext(ScrollDetectionContext);

interface ScrollDetectionProviderProps {
  children: ReactNode;
}

export default function ScrollDetectionProvider({ children }: ScrollDetectionProviderProps) {
  const {
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    shouldPreventClick
  } = useScrollDetection();

  // Memoize context value to prevent unnecessary consumer re-renders.
  // shouldPreventClick is a stable useCallback ref that reads from refs internally,
  // so it never changes identity and this value object stays stable.
  const contextValue = useMemo(() => ({
    isScrolling: false,
    shouldPreventClick
  }), [shouldPreventClick]);

  return (
    <ScrollDetectionContext.Provider value={contextValue}>
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ height: '100%', width: '100%' }}
      >
        {children}
      </div>
    </ScrollDetectionContext.Provider>
  );
}
