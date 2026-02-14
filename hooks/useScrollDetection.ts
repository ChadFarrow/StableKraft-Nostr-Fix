'use client';

import { useEffect, useRef, useCallback } from 'react';

interface UseScrollDetectionResult {
  isScrolling: boolean;
  handleTouchStart: (e: TouchEvent | React.TouchEvent) => void;
  handleTouchMove: (e: TouchEvent | React.TouchEvent) => void;
  handleTouchEnd: (e: TouchEvent | React.TouchEvent) => void;
  shouldPreventClick: () => boolean;
}

export function useScrollDetection(): UseScrollDetectionResult {
  // Use refs instead of useState to avoid triggering React re-renders on every scroll event.
  // This is critical for performance: with useState, every scroll frame caused the
  // ScrollDetectionProvider to re-render, which cascaded to the entire component tree.
  const isScrollingRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout>();

  const handleTouchStart = useCallback((e: TouchEvent | React.TouchEvent) => {
    const touch = ('touches' in e && e.touches.length > 0) ? e.touches[0] :
                  ('changedTouches' in e && e.changedTouches.length > 0) ? e.changedTouches[0] : null;
    if (!touch) return;

    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now()
    };
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent | React.TouchEvent) => {
    if (!touchStartRef.current) return;

    const touch = ('touches' in e && e.touches.length > 0) ? e.touches[0] :
                  ('changedTouches' in e && e.changedTouches.length > 0) ? e.changedTouches[0] : null;
    if (!touch) return;
    const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);

    // If moved more than 20px, consider it scrolling (increased sensitivity)
    if (deltaX > 20 || deltaY > 20) {
      isScrollingRef.current = true;

      // Clear existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      // Reset scrolling state after 300ms of no movement (increased timeout)
      scrollTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false;
      }, 300);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    // Keep scrolling state for a longer time to prevent immediate clicks after scrolling
    if (isScrollingRef.current) {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false;
      }, 250);
    }
    touchStartRef.current = null;
  }, []);

  const shouldPreventClick = useCallback(() => {
    if (!touchStartRef.current) return isScrollingRef.current;

    const timeSinceStart = Date.now() - touchStartRef.current.time;
    // Prevent clicks that happen too quickly (likely accidental taps) - increased threshold
    return isScrollingRef.current || timeSinceStart < 200;
  }, []);

  // Global scroll detection
  useEffect(() => {
    let scrollTimeout: NodeJS.Timeout;

    const handleScroll = () => {
      isScrollingRef.current = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isScrollingRef.current = false;
      }, 300);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollTimeout);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  return {
    isScrolling: isScrollingRef.current,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    shouldPreventClick
  };
}
