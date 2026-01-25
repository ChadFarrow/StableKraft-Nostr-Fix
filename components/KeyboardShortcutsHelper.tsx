'use client';

import { useState } from 'react';
import { Keyboard } from 'lucide-react';

/**
 * Keyboard shortcuts help tooltip
 * Shows available keyboard shortcuts to users
 */
export function KeyboardShortcutsHelper() {
  const [isOpen, setIsOpen] = useState(false);

  const shortcuts = [
    { key: 'Space', action: 'Play / Pause' },
    { key: '→', action: 'Next Track' },
    { key: '←', action: 'Previous Track' },
    { key: '/', action: 'Focus Search' },
    { key: 'Esc', action: 'Close Modals' },
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors border border-gray-600/50 hover:border-gray-500/50"
        title="Keyboard Shortcuts"
        aria-label="Show keyboard shortcuts"
      >
        <Keyboard className="w-4 h-4 text-gray-300" />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          
          {/* Tooltip */}
          <div className="absolute right-0 top-12 z-50 bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-xl shadow-2xl p-4 min-w-[280px]">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <Keyboard className="w-4 h-4" />
              Keyboard Shortcuts
            </h3>
            
            <div className="space-y-2">
              {shortcuts.map((shortcut) => (
                <div
                  key={shortcut.key}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-300">{shortcut.action}</span>
                  <kbd className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-xs font-mono text-gray-200">
                    {shortcut.key}
                  </kbd>
                </div>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-gray-700">
              <p className="text-xs text-gray-400">
                Shortcuts work globally except when typing
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
