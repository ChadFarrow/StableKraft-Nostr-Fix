'use client';

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

/**
 * Provider component that enables global keyboard shortcuts
 * Should be placed high in the component tree
 */
export default function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  useKeyboardShortcuts();
  return <>{children}</>;
}
