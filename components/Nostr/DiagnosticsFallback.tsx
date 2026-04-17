'use client';

import React from 'react';

interface DiagnosticsFallbackProps {
  value: string | null;
  onClose: () => void;
  /** 'light' for the LoginModal surface, 'dark' for UserMenu's dropdown. */
  theme?: 'light' | 'dark';
}

/**
 * Inline textarea panel shown when `navigator.clipboard.writeText` is
 * unavailable (HTTP origin, older iOS Safari, etc.). The user long-presses
 * the textarea to select-all and copy the diagnostics report manually.
 */
export default function DiagnosticsFallback({
  value,
  onClose,
  theme = 'light',
}: DiagnosticsFallbackProps) {
  if (value === null) return null;

  const isDark = theme === 'dark';

  return (
    <div
      className={
        isDark
          ? 'mt-3 pt-3 border-t border-gray-700'
          : 'mt-4 border-t border-gray-200 pt-4'
      }
    >
      <div className="flex items-center justify-between mb-2">
        <p
          className={
            isDark
              ? 'text-xs text-gray-400'
              : 'text-xs text-gray-700 font-medium'
          }
        >
          {isDark
            ? 'Clipboard unavailable — long-press to select & copy.'
            : 'Clipboard unavailable — long-press the text below to select and copy.'}
        </p>
        <button
          type="button"
          onClick={onClose}
          className={
            isDark
              ? 'text-xs text-gray-500 hover:text-gray-300'
              : 'text-xs text-gray-500 hover:text-gray-700'
          }
        >
          Close
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className={`w-full h-48 text-[10px] font-mono rounded-md p-2 ${
          isDark
            ? 'border border-gray-700 bg-gray-800 text-gray-300'
            : 'border border-gray-300 bg-gray-50'
        }`}
      />
    </div>
  );
}
