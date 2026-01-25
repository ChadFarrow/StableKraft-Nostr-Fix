'use client';

import { useState } from 'react';
import { Share2, Check, Copy } from 'lucide-react';
import { toast } from './Toast';

interface ShareButtonProps {
  url?: string;
  title?: string;
  text?: string;
  className?: string;
}

/**
 * Share button with Web Share API fallback to clipboard
 * Uses native share on mobile, copies link on desktop
 */
export function ShareButton({ url, title, text, className = '' }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const shareUrl = url || window.location.href;
    const shareTitle = title || document.title;
    const shareText = text || '';

    // Check if Web Share API is available
    if (navigator.share) {
      try {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          url: shareUrl,
        });
      } catch (error) {
        // User cancelled or error occurred
        if ((error as Error).name !== 'AbortError') {
          // Fallback to clipboard
          copyToClipboard(shareUrl);
        }
      }
    } else {
      // Fallback to clipboard
      copyToClipboard(shareUrl);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Link copied to clipboard!');
      
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toast.error('Failed to copy link');
    }
  };

  return (
    <button
      onClick={handleShare}
      className={`p-2 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-all duration-200 border border-gray-600/50 hover:border-gray-500/50 active:scale-95 ${className}`}
      title="Share"
      aria-label="Share this page"
    >
      {copied ? (
        <Check className="w-4 h-4 text-green-400" />
      ) : (
        <Share2 className="w-4 h-4 text-gray-300" />
      )}
    </button>
  );
}
