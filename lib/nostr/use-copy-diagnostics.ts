'use client';

import { useCallback, useState } from 'react';
import {
  buildDiagnosticsReport,
  type DiagnosticsSnapshotInput,
} from './login-diagnostics';

export type CopyDiagnosticsState = 'idle' | 'copied' | 'failed';

export interface UseCopyDiagnostics {
  copyState: CopyDiagnosticsState;
  fallback: string | null;
  setFallback: (value: string | null) => void;
  copy: (input: DiagnosticsSnapshotInput) => Promise<void>;
}

/**
 * Shared clipboard-or-textarea-fallback logic for the diagnostics report.
 * On secure contexts the report goes to the clipboard; on HTTP / older Safari
 * we expose `fallback` so the caller can render a textarea the user can
 * long-press to copy. Used by LoginModal and UserMenu.
 */
export function useCopyDiagnostics(): UseCopyDiagnostics {
  const [copyState, setCopyState] = useState<CopyDiagnosticsState>('idle');
  const [fallback, setFallback] = useState<string | null>(null);

  const copy = useCallback(async (input: DiagnosticsSnapshotInput) => {
    const report = buildDiagnosticsReport(input);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        setCopyState('copied');
        setTimeout(() => setCopyState('idle'), 2500);
      } else {
        setFallback(report);
      }
    } catch {
      // Some mobile browsers reject clipboard.writeText without a user-gesture
      // heuristic they accept — fall back to the textarea path.
      setFallback(report);
    }
  }, []);

  return { copyState, fallback, setFallback, copy };
}
