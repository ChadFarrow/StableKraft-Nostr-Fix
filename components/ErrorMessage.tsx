'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';

interface ErrorMessageProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  actionLabel?: string;
  className?: string;
}

/**
 * Improved error message component with better UX
 * Provides clear, actionable error messages with retry functionality
 */
export function ErrorMessage({
  title = 'Something went wrong',
  message,
  onRetry,
  actionLabel = 'Try Again',
  className = '',
}: ErrorMessageProps) {
  return (
    <div
      className={`bg-red-500/10 border border-red-500/30 rounded-xl p-6 backdrop-blur-sm ${className}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-start gap-4">
        {/* Error Icon */}
        <div className="flex-shrink-0">
          <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
            <AlertCircle className="w-6 h-6 text-red-400" aria-hidden="true" />
          </div>
        </div>

        {/* Error Content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-red-400 mb-2">{title}</h3>
          <p className="text-gray-300 text-sm leading-relaxed">{message}</p>

          {/* Retry Button */}
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-all duration-200 shadow-md hover:shadow-lg active:scale-95 font-medium"
              aria-label={actionLabel}
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline error message for forms and smaller contexts
 */
export function InlineError({ message, className = '' }: { message: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 text-red-400 text-sm ${className}`} role="alert">
      <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
