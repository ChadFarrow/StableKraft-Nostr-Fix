'use client';

import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { isAndroid, isIOS } from '@/lib/utils/device';

interface Nip46ConnectProps {
  connectionToken: string;
  signerUrl: string;
  onConnected: () => void;
  onError: (error: string) => void;
  onCancel: () => void;
  signerApp?: 'amber' | 'primal';
}

export default function Nip46Connect({
  connectionToken,
  signerUrl,
  onConnected,
  onError,
  onCancel,
  signerApp = 'amber',
}: Nip46ConnectProps) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'waiting' | 'connecting' | 'connected' | 'error'>('waiting');
  const [deepLinkUrl, setDeepLinkUrl] = useState<string>('');
  const [errorLog, setErrorLog] = useState<Array<{ timestamp: string; message: string; details?: any }>>([]);
  const [showErrorLog, setShowErrorLog] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{
    relayUrl?: string;
    appPubkey?: string;
    eventsReceived?: number;
    lastEventTime?: string;
    connectionCheckCount?: number;
  }>({});

  // Set up error logging from console
  useEffect(() => {
    const originalError = console.error;
    const originalWarn = console.warn;
    
    // Intercept console errors and warnings related to NIP-46/Amber
    console.error = (...args: any[]) => {
      originalError(...args);
      const message = args.map(arg => 
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');
      
      if (message.includes('NIP-46') || message.includes('Amber') || message.includes('Primal') || message.includes('relay')) {
        setErrorLog(prev => [...prev.slice(-19), {
          timestamp: new Date().toLocaleTimeString(),
          message: message.substring(0, 200),
          details: args.length > 1 ? args.slice(1) : undefined,
        }]);
      }
    };

    console.warn = (...args: any[]) => {
      originalWarn(...args);
      const message = args.map(arg =>
        typeof arg === 'string' ? arg : JSON.stringify(arg)
      ).join(' ');

      if (message.includes('NIP-46') || message.includes('Amber') || message.includes('Primal') || message.includes('relay')) {
        setErrorLog(prev => [...prev.slice(-19), {
          timestamp: new Date().toLocaleTimeString(),
          message: `⚠️ ${message.substring(0, 200)}`,
          details: args.length > 1 ? args.slice(1) : undefined,
        }]);
      }
    };
    
    return () => {
      console.error = originalError;
      console.warn = originalWarn;
    };
  }, []);

  // Poll for connection status and update debug info
  useEffect(() => {
    // Get debug info from sessionStorage
    const pendingConnection = sessionStorage.getItem('nip46_pending_connection');
    if (pendingConnection) {
      try {
        const connectionInfo = JSON.parse(pendingConnection);
        setDebugInfo(prev => ({
          ...prev,
          relayUrl: connectionInfo.relayUrl,
          appPubkey: connectionInfo.publicKey ? connectionInfo.publicKey.slice(0, 16) + '...' : undefined,
        }));

        console.log('NIP-46: QR Code generated for relay:', connectionInfo.relayUrl);
      } catch (err) {
        // Ignore parse errors
      }
    }

    if (connectionStatus === 'waiting' || connectionStatus === 'connecting') {
      let checkCount = 0;
      const TIMEOUT_SECONDS = 60;
      const CHECK_INTERVAL_MS = 2000;
      const MAX_CHECKS = (TIMEOUT_SECONDS * 1000) / CHECK_INTERVAL_MS; // 30 checks

      const interval = setInterval(() => {
        checkCount++;

        // Try to get event count from console logs (if available in window)
        let eventsReceived = 0;
        if (typeof window !== 'undefined' && (window as any).__NIP46_EVENT_COUNT__) {
          eventsReceived = (window as any).__NIP46_EVENT_COUNT__;
        }

        setDebugInfo(prev => ({
          ...prev,
          connectionCheckCount: checkCount,
          eventsReceived: eventsReceived || prev.eventsReceived || 0,
        }));

        // Check for timeout (60 seconds)
        if (checkCount >= MAX_CHECKS) {
          console.error('⏱️ NIP-46: Connection timeout after 60 seconds');
          setConnectionStatus('error');
          setIsConnecting(false);

          const errorMessage = `Connection timed out after ${TIMEOUT_SECONDS} seconds.\n\nMake sure you:\n1. Scanned the QR code and approved the connection in ${appName}\n2. Have a stable internet connection\n3. Aren't blocking the relay connection with ad blockers or privacy extensions`;

          onError(errorMessage);
          return;
        }

        // Check if connection was established (stored in localStorage)
        // The key should match what saveNIP46Connection uses: 'nostr_nip46_connection'
        const storedConnection = localStorage.getItem('nostr_nip46_connection');
        if (storedConnection) {
          try {
            const connection = JSON.parse(storedConnection);
            // Check if connection has a pubkey (means it's connected)
            if (connection.pubkey) {
              console.log('NIP-46: Connection established');
              setConnectionStatus('connected');
              setIsConnecting(false);
              setDebugInfo(prev => ({
                ...prev,
                lastEventTime: new Date().toLocaleTimeString(),
              }));
              // Call onConnected after a short delay to allow UI to update
              setTimeout(() => {
                onConnected();
              }, 500);
            }
          } catch (err) {
            // Ignore parse errors
          }
        }
      }, CHECK_INTERVAL_MS); // Check every 2 seconds

      return () => clearInterval(interval);
    }
  }, [connectionStatus, onConnected, connectionToken, debugInfo.relayUrl, debugInfo.appPubkey]);

  // Generate deep link URL for signer app
  useEffect(() => {
    if (signerApp === 'primal' && isIOS()) {
      // Primal on iOS handles nostrconnect:// URIs
      setDeepLinkUrl(connectionToken);
    } else if (isAndroid()) {
      // Amber supports nostrconnect:// URIs directly
      setDeepLinkUrl(connectionToken);
    }
  }, [connectionToken, signerUrl, signerApp]);

  const handleDeepLink = () => {
    if (deepLinkUrl) {
      // Use window.open to launch the signer app while keeping the browser page active.
      // On iOS, window.open with _blank lets the OS open the app without replacing the
      // current page, making it easier for the user to return to the browser.
      const opened = window.open(deepLinkUrl, '_blank');
      if (!opened) {
        // Fallback: if popup was blocked, try location.href
        window.location.href = deepLinkUrl;
      }
      setIsConnecting(true);
      setConnectionStatus('connecting');
    }
  };

  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(connectionToken);
      alert('Connection token copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy token:', err);
    }
  };

  const isMobile = isAndroid() || isIOS();
  const appName = signerApp === 'primal' ? 'Primal' : 'Amber';
  const isPrimalIOS = signerApp === 'primal' && isIOS();

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h3 className="text-lg font-semibold mb-2">Connect with {appName}</h3>
        <p className="text-sm text-gray-600 mb-4">
          {isPrimalIOS
            ? 'Tap the button below to open Primal and approve the connection, or copy the link to paste manually'
            : isMobile
            ? `Copy the connection link below and paste it into ${appName}, or tap the button to open ${appName} directly`
            : `Scan the QR code with ${appName} on your phone, or copy the connection URI and paste it into ${appName}`}
        </p>
      </div>

      {/* QR Code - Desktop only */}
      {!isMobile && (
        <div className="flex justify-center p-4 bg-white rounded-lg border border-gray-200">
          <QRCodeSVG
            value={connectionToken}
            size={256}
            level="M"
            includeMargin={true}
          />
        </div>
      )}

      {/* Connection URI - Prominent on mobile, collapsible on desktop */}
      {isMobile ? (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">Connection Link</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={connectionToken}
              readOnly
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-sm font-mono text-xs"
            />
            <button
              onClick={handleCopyToken}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium"
            >
              Copy
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Copy this link and paste it into {appName}&apos;s connection field
          </p>
        </div>
      ) : (
        <details className="group">
          <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-800 list-none flex items-center gap-2">
            <span className="transition-transform group-open:rotate-90">▶</span>
            <span>Or copy connection link</span>
          </summary>
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={connectionToken}
                readOnly
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-sm font-mono text-xs"
              />
              <button
                onClick={handleCopyToken}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-md text-sm"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Paste this in {appName} on your phone to connect
            </p>
          </div>
        </details>
      )}

      {/* Deep Link Button (Android for Amber, iOS for Primal) */}
      {((isAndroid() && deepLinkUrl) || (isPrimalIOS && deepLinkUrl)) && (
        <div className="space-y-2">
          <button
            onClick={handleDeepLink}
            disabled={isConnecting}
            className={`w-full px-4 py-3 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed font-medium ${
              signerApp === 'primal'
                ? 'bg-purple-600 hover:bg-purple-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isConnecting ? `Approve in ${appName}, then come back here` : `Sign in with ${appName}`}
          </button>
          <p className="text-xs text-gray-500 text-center">
            {isConnecting
              ? `Switch back to this browser after approving`
              : `Opens ${appName} to sign in — you'll come back here after`}
          </p>
        </div>
      )}

      {/* Connection Status */}
      {connectionStatus === 'connecting' && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-md space-y-3">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
          <p className="text-sm text-blue-800 text-center font-medium">
            Waiting for {appName} to connect...
          </p>
          <p className="text-xs text-blue-600 text-center">
            {isMobile
              ? `Approve the connection in ${appName}, then switch back to your browser`
              : `Please scan the QR code and approve the connection in ${appName}`}
          </p>
          {isMobile && (
            <p className="text-xs text-purple-700 text-center font-medium">
              After approving, swipe back to this browser tab
            </p>
          )}
          {debugInfo.connectionCheckCount && debugInfo.connectionCheckCount > 10 && (
            <p className="text-xs text-yellow-700 text-center">
              Still waiting... {!isMobile && 'Check the browser console (F12) for details'}
            </p>
          )}
        </div>
      )}

      {connectionStatus === 'connected' && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-md">
          <p className="text-sm text-green-800 text-center">
            ✅ Connected successfully!
          </p>
        </div>
      )}

      {connectionStatus === 'error' && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-800 text-center mb-2">
            ❌ Connection failed. Please try again.
          </p>
          {errorLog.length > 0 && (
            <button
              onClick={() => setShowErrorLog(!showErrorLog)}
              className="text-xs text-red-600 hover:text-red-800 underline"
            >
              {showErrorLog ? 'Hide' : 'Show'} error log ({errorLog.length})
            </button>
          )}
        </div>
      )}

      {/* Error Log Display */}
      {showErrorLog && errorLog.length > 0 && (
        <div className="p-4 bg-gray-900 text-gray-100 rounded-md border border-gray-700 max-h-64 overflow-y-auto">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-sm font-semibold">Error Log</h4>
            <button
              onClick={() => setErrorLog([])}
              className="text-xs text-gray-400 hover:text-gray-200"
            >
              Clear
            </button>
          </div>
          <div className="space-y-1 text-xs font-mono">
            {errorLog.map((error, index) => (
              <div key={index} className="border-b border-gray-700 pb-1">
                <div className="text-gray-400 text-xs mb-1">{error.timestamp}</div>
                <div className="text-red-300 break-words">{error.message}</div>
                {error.details && error.details.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-gray-400 cursor-pointer text-xs">Details</summary>
                    <pre className="text-xs text-gray-500 mt-1 overflow-x-auto">
                      {JSON.stringify(error.details, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Debug Info Panel (development only) */}
      {!isAndroid() && process.env.NODE_ENV !== 'production' && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-sm font-semibold text-blue-900">Debug Info</h4>
            <button
              onClick={() => setShowErrorLog(!showErrorLog)}
              className="text-xs text-blue-600 hover:text-blue-800 underline"
            >
              {showErrorLog ? 'Hide' : 'Show'} error log {errorLog.length > 0 && `(${errorLog.length})`}
            </button>
          </div>
          <div className="text-xs text-blue-800 space-y-1">
            {debugInfo.relayUrl && (
              <div>Relay: <span className="font-mono">{debugInfo.relayUrl}</span></div>
            )}
            {debugInfo.appPubkey && (
              <div>App Pubkey: <span className="font-mono">{debugInfo.appPubkey}</span></div>
            )}
            {debugInfo.connectionCheckCount !== undefined && (
              <div>Connection Checks: {debugInfo.connectionCheckCount}</div>
            )}
            {errorLog.length > 0 && (
              <div className="text-red-600 font-semibold">
                ⚠️ {errorLog.length} error(s) logged
              </div>
            )}
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="p-4 bg-gray-50 border border-gray-200 rounded-md">
        <h4 className="text-sm font-semibold mb-2">How to connect:</h4>
        {signerApp === 'primal' ? (
          <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
            {isMobile ? (
              <>
                <li>Tap &quot;Sign in with Primal&quot; above</li>
                <li>Approve the connection in Primal</li>
                <li><strong>Switch back to this browser</strong> after approving</li>
                <li>Connection completes automatically</li>
              </>
            ) : (
              <>
                <li>Scan the QR code above with your phone&apos;s camera, or</li>
                <li>Copy the connection link and paste it into Primal</li>
                <li>Approve the connection request in Primal</li>
                <li>Primal auto-signs with Full trust — connection should be near-instant</li>
              </>
            )}
          </ol>
        ) : (
          <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
            <li>Open the Amber app on your device</li>
            <li>Go to Settings → Remote Signing (NIP-46) or use the &quot;Connect&quot; option</li>
            {isMobile ? (
              isAndroid() ? (
                <li>Tap &quot;Open in Amber App&quot; button above, or copy the connection link and paste it in Amber</li>
              ) : (
                <li>Copy the connection link above and paste it into Amber&apos;s connection field</li>
              )
            ) : (
              <>
                <li>Scan the QR code above with your phone&apos;s camera, or</li>
                <li>Copy the connection link and paste it into Amber&apos;s connection field</li>
              </>
            )}
            <li>Approve the connection request in Amber</li>
            <li>Wait for the connection to be established</li>
          </ol>
        )}
      </div>

      {/* Manual Check/Continue Buttons - Show when connecting or waiting */}
      {(connectionStatus === 'connecting' || connectionStatus === 'waiting') && (
        <div className="flex gap-2">
          <button
            onClick={() => {
              // Force check connection status
              const storedConnection = localStorage.getItem('nostr_nip46_connection');
              if (storedConnection) {
                try {
                  const connection = JSON.parse(storedConnection);
                  if (connection.pubkey) {
                    setConnectionStatus('connected');
                    setIsConnecting(false);
                    setTimeout(() => onConnected(), 500);
                  } else {
                    alert(`Connection not yet established. Please approve the connection in ${appName}.`);
                  }
                } catch (err) {
                  alert('Error checking connection status.');
                }
              } else {
                alert(`No connection found. Make sure you've approved the connection in ${appName}.`);
              }
            }}
            className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-md text-sm"
          >
            Check Status
          </button>
          <button
            onClick={() => {
              setConnectionStatus('connected');
              setIsConnecting(false);
              setTimeout(() => onConnected(), 500);
            }}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium"
          >
            Continue
          </button>
        </div>
      )}

    </div>
  );
}

