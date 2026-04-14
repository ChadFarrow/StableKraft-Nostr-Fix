'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { NIP46Client } from '@/lib/nostr/nip46-client';
import { getUnifiedSigner } from '@/lib/nostr/signer';
import { saveNIP46Connection } from '@/lib/nostr/nip46-storage';
import Nip46Connect from './Nip46Connect';
import { useNip46Connection } from './hooks';
import {
  preserveWalletConnection,
  prepareLoginEvent,
  processSignedLogin,
} from '@/lib/nostr/auth-utils';

interface LoginModalProps {
  onClose: () => void;
}

export default function LoginModal({ onClose }: LoginModalProps) {
  // Core UI state
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [loginMethod, setLoginMethod] = useState<'nostr-login' | 'primal'>('nostr-login');

  // NIP-46 connection hook (used by Primal tab)
  const {
    nip46Client,
    showNip46Connect,
    nip46ConnectionToken,
    nip46SignerUrl,
    amberConnectionError,
    isInitializingAmber,
    setShowNip46Connect,
    setAmberConnectionError,
    setAmberConnectionInitialized,
    cleanupAmberConnection,
    nip46ClientRef,
  } = useNip46Connection({ loginMethod, isSubmitting });

  // Ensure we're mounted before rendering portal
  useEffect(() => {
    setMounted(true);
    // Close any open dropdowns when modal opens
    const closeDropdowns = () => {
      document.body.click();
    };
    closeDropdowns();
    return () => setMounted(false);
  }, []);



  const handleNip46Connected = async () => {
    // Use the ref to get the client
    const client = nip46ClientRef.current || nip46Client;
    if (!client) {
      setError('NIP-46 client not initialized. Please try connecting again.');
      setIsSubmitting(false);
      return;
    }
    await handleNip46ConnectedWithClient(client);
  };

  const handleNip46ConnectedWithClient = async (client: NIP46Client) => {
    try {
      setIsSubmitting(true);
      setError(null);

      // Wait a bit to ensure connection is fully established
      await new Promise(resolve => setTimeout(resolve, 500));

      // Get public key from signer
      // For relay-based connections, Amber might not send a connection event.
      // Instead, we need to try requesting the public key and see if we get a response.
      console.log('🔍 LoginModal: Getting public key from NIP-46 client...');
      
      // Check connection status explicitly (matching test page pattern)
      const connection = client.getConnection();
      const isConnected = client.isConnected();
      const pubkey = client.getPubkey();
      
      console.log('🔍 LoginModal: Pre-sign connection check:', {
        hasClient: !!client,
        isConnected,
        hasConnection: !!connection,
        hasPubkey: !!pubkey,
        pubkey: pubkey ? pubkey.slice(0, 16) + '...' : 'N/A',
        connectionPubkey: connection?.pubkey ? connection.pubkey.slice(0, 16) + '...' : 'N/A',
        signerUrl: connection?.signerUrl || 'N/A',
      });
      
      let publicKey: string;
      
      // If we already have the pubkey, use it
      if (pubkey) {
        console.log('✅ LoginModal: Using pubkey from client:', pubkey.slice(0, 16) + '...');
        publicKey = pubkey;
      } else if (connection?.pubkey) {
        console.log('✅ LoginModal: Using pubkey from connection:', connection.pubkey.slice(0, 16) + '...');
        publicKey = connection.pubkey;
      } else {
        // Verify connection is established before requesting pubkey
        if (!isConnected || !connection) {
          throw new Error(`Not connected to signer. Connection status: connected=${isConnected}, hasConnection=${!!connection}. Please wait for the connection to be established.`);
        }
        
        console.log('⚠️ LoginModal: No pubkey available yet. Requesting from signer...');
        console.log('📱 IMPORTANT: Watch your device - your signer should show a notification or prompt');

        // Try requesting the public key - this will work if the signer is listening
        try {
          console.log('⏳ LoginModal: Waiting 2 seconds for signer to be ready...');
          // Wait a bit for signer to be ready
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log('📤 LoginModal: Requesting public key from Amber via relay...');
          console.log('📋 LoginModal: Connection details:', {
            relayUrl: connection?.signerUrl,
            hasRelayClient: !!client,
            isConnected,
          });
          
          // Set a timeout warning
          const timeoutWarning = setTimeout(() => {
            console.warn('⚠️ LoginModal: Still waiting for public key response (30s elapsed). This might indicate:');
            console.warn('  1. Amber hasn\'t approved the connection yet');
            console.warn('  2. Amber is not connected to the same relay');
            console.warn('  3. Network/relay connectivity issues');
          }, 30000);
          
          publicKey = await client.getPublicKey();
          clearTimeout(timeoutWarning);
          console.log('✅ LoginModal: Got public key from signer:', publicKey.slice(0, 16) + '...');
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const errorDetails = err instanceof Error ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          } : err;
          
          console.error('❌ LoginModal: Failed to get public key:', {
            error: errorMessage,
            errorDetails,
            connectionState: {
              hasConnection: !!connection,
              hasPubkey: !!connection?.pubkey,
              connected: connection?.connected,
              relayUrl: connection?.signerUrl,
              isConnected,
            },
          });
          
          // Provide more helpful error message
          let helpfulMessage = `Unable to communicate with signer: ${errorMessage}`;
          if (errorMessage.includes('timeout')) {
            helpfulMessage += '\n\nPossible causes:\n';
            helpfulMessage += '1. Amber hasn\'t approved the connection yet - check your phone\n';
            helpfulMessage += '2. Amber is not connected to the same relay\n';
            helpfulMessage += '3. Network connectivity issues\n';
            helpfulMessage += '\nTry:\n';
            helpfulMessage += '- Make sure you scanned the QR code and approved in Amber\n';
            helpfulMessage += '- Check that Amber is using the relay: ' + (connection?.signerUrl || 'unknown') + '\n';
            helpfulMessage += '- Try clicking "Continue" button to retry';
          }
          
          throw new Error(helpfulMessage);
        }
      }
      
      if (!publicKey || publicKey.length === 0) {
        throw new Error('Failed to get public key from signer. Please try connecting again.');
      }
      
      // Verify connection is ready before signing
      console.log('✅ LoginModal: Connection verified, proceeding with challenge signing');

      // Request signature for challenge
      const challengeResponse = await fetch('/api/nostr/auth/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!challengeResponse.ok) {
        throw new Error(`Failed to get challenge: ${challengeResponse.status}`);
      }

      const challengeData = await challengeResponse.json();
      if (!challengeData.challenge) {
        throw new Error('Invalid challenge response');
      }

      const challenge = challengeData.challenge;

      // Validate challenge
      if (!challenge || typeof challenge !== 'string' || challenge.length === 0) {
        throw new Error('Invalid challenge received from server');
      }

      // Verify connection is still valid before signing
      const finalConnectionCheck = client.getConnection();
      const finalIsConnected = client.isConnected();
      if (!finalIsConnected || !finalConnectionCheck) {
        throw new Error('Connection lost before signing. Please reconnect and try again.');
      }
      
      // Create standardized login event template
      const { createLoginEventTemplate } = await import('@/lib/nostr/events');
      const event = createLoginEventTemplate(challenge);

      console.log('✍️ LoginModal: Requesting signature from NIP-46 signer...', {
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        created_at: event.created_at,
        challenge: challenge.slice(0, 16) + '...',
      });
      console.log('📱 IMPORTANT: Watch your phone - Amber should show a notification or prompt to approve the signature');

      let signedEvent: any;
      try {
        signedEvent = await client.signEvent(event as any);
      } catch (signError) {
        const errorMessage = signError instanceof Error ? signError.message : String(signError);
        const errorDetails = signError instanceof Error ? {
          name: signError.name,
          message: signError.message,
          stack: signError.stack,
        } : signError;
        
        console.error('❌ LoginModal: Error signing event:', {
          error: errorMessage,
          errorDetails,
          eventDetails: {
            kind: event.kind,
            challenge: challenge.slice(0, 16) + '...',
            created_at: event.created_at,
          },
        });
        
        throw new Error(`Failed to sign event: ${errorMessage}`);
      }
      console.log('✅ LoginModal: Got signed event', {
        id: signedEvent.id?.slice(0, 16) + '...',
        pubkey: signedEvent.pubkey?.slice(0, 16) + '...',
        sig: signedEvent.sig?.slice(0, 16) + '...',
        created_at: signedEvent.created_at,
        kind: signedEvent.kind,
        content: signedEvent.content,
        hasAllFields: !!(signedEvent.id && signedEvent.pubkey && signedEvent.sig && signedEvent.created_at),
      });

      console.log('🔍 FULL SIGNED EVENT:', JSON.stringify(signedEvent, null, 2));

      // Validate signed event has all required fields
      if (!signedEvent) {
        console.error('❌ LoginModal: Signed event is null or undefined');
        throw new Error('Failed to sign event. Please try again.');
      }

      // Validate each required field individually with detailed error messages
      const missingFields: string[] = [];
      if (!signedEvent.pubkey || typeof signedEvent.pubkey !== 'string' || signedEvent.pubkey.length === 0) {
        missingFields.push('pubkey');
      }
      if (!signedEvent.sig || typeof signedEvent.sig !== 'string' || signedEvent.sig.length === 0) {
        missingFields.push('sig');
      }
      if (!signedEvent.id || typeof signedEvent.id !== 'string' || signedEvent.id.length === 0) {
        missingFields.push('id');
      }
      if (!signedEvent.created_at || typeof signedEvent.created_at !== 'number') {
        missingFields.push('created_at');
      }

      if (missingFields.length > 0) {
        console.error('❌ LoginModal: Signed event missing required fields:', {
          missingFields,
          hasEvent: !!signedEvent,
          pubkey: signedEvent.pubkey ? `${signedEvent.pubkey.slice(0, 16)}...` : 'MISSING',
          sig: signedEvent.sig ? `${signedEvent.sig.slice(0, 16)}...` : 'MISSING',
          id: signedEvent.id ? `${signedEvent.id.slice(0, 16)}...` : 'MISSING',
          created_at: signedEvent.created_at,
          fullEvent: JSON.stringify(signedEvent, null, 2),
        });
        throw new Error(`Signed event is missing required fields: ${missingFields.join(', ')}. Please try again.`);
      }

      // Validate challenge is present
      if (!challenge || typeof challenge !== 'string' || challenge.length === 0) {
        console.error('❌ LoginModal: Challenge is missing or invalid:', challenge);
        throw new Error('Challenge is missing. Please try again.');
      }

      // Calculate npub from public key
      const { publicKeyToNpub } = await import('@/lib/nostr/keys');
      let npub: string;
      try {
        npub = publicKeyToNpub(signedEvent.pubkey);
      } catch (error) {
        console.error('❌ LoginModal: Failed to calculate npub:', error);
        throw new Error('Failed to calculate npub from public key. Please try again.');
      }

      // Prepare login payload with explicit validation
      // Use defensive checks to avoid .trim() errors on undefined/null values
      const loginPayload = {
        publicKey: (signedEvent.pubkey || '').trim(),
        npub: (npub || '').trim(),
        challenge: (challenge || '').trim(),
        signature: (signedEvent.sig || '').trim(),
        eventId: (signedEvent.id || '').trim(),
        createdAt: signedEvent.created_at,
        kind: signedEvent.kind, // Include kind so API can reconstruct event
        content: signedEvent.content || '', // Include content so API can reconstruct event
      };

      // Final validation of payload before sending
      const payloadMissingFields: string[] = [];
      if (!loginPayload.publicKey || loginPayload.publicKey.length === 0) payloadMissingFields.push('publicKey');
      if (!loginPayload.challenge || loginPayload.challenge.length === 0) payloadMissingFields.push('challenge');
      if (!loginPayload.signature || loginPayload.signature.length === 0) payloadMissingFields.push('signature');
      if (!loginPayload.eventId || loginPayload.eventId.length === 0) payloadMissingFields.push('eventId');
      if (!loginPayload.createdAt || typeof loginPayload.createdAt !== 'number') payloadMissingFields.push('createdAt');

      if (payloadMissingFields.length > 0) {
        console.error('❌ LoginModal: Login payload missing required fields:', {
          missingFields: payloadMissingFields,
          payload: loginPayload,
        });
        throw new Error(`Login payload is missing required fields: ${payloadMissingFields.join(', ')}. Please try again.`);
      }

      console.log('📤 LoginModal: Sending login request with payload:', {
        publicKey: loginPayload.publicKey.slice(0, 16) + '...',
        npub: loginPayload.npub.slice(0, 16) + '...',
        challenge: loginPayload.challenge.slice(0, 16) + '...',
        signature: loginPayload.signature.slice(0, 16) + '...',
        eventId: loginPayload.eventId.slice(0, 16) + '...',
        createdAt: loginPayload.createdAt,
        kind: loginPayload.kind,
        content: loginPayload.content,
      });

      console.log('🌐 LOGIN REQUEST - FULL PAYLOAD:', JSON.stringify(loginPayload, null, 2));

      // Login with signed event
      console.log('📡 About to fetch /api/nostr/auth/login...');
      let loginResponse;
      try {
        loginResponse = await fetch('/api/nostr/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(loginPayload),
        });
        console.log('📡 Login response received:', loginResponse.status, loginResponse.statusText);
      } catch (fetchError) {
        console.error('❌ LoginModal: Fetch request failed:', fetchError);
        const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        throw new Error(`Network request failed: ${errorMsg}`);
      }

      if (!loginResponse.ok) {
        let errorData;
        try {
          errorData = await loginResponse.json();
        } catch (jsonError) {
          console.error('❌ LoginModal: Failed to parse error response JSON:', jsonError);
          throw new Error(`Login failed: ${loginResponse.status} ${loginResponse.statusText}`);
        }
        console.error('❌ LoginModal: Login request returned error:', errorData);
        throw new Error(errorData.error || `Login failed: ${loginResponse.status}`);
      }

      const loginData = await loginResponse.json();
      if (loginData.success && loginData.user) {
        // Detect if this is nsecBunker (bunker:// URI)
        const connection = client.getConnection();
        const isNsecBunker = connection?.signerUrl?.includes('bunker://') ?? false;
        const loginType = isNsecBunker ? 'nsecbunker' : 'nip46';
        
        // Clear stale connections for other users before saving
        const { clearNIP46ConnectionForUser } = await import('@/lib/nostr/nip46-storage');
        // Get all stored connections and clear ones that don't match this user
        try {
          const byPubkey = JSON.parse(localStorage.getItem('nostr_nip46_connections_by_pubkey') || '{}');
          Object.keys(byPubkey).forEach((pubkey) => {
            if (pubkey !== loginData.user.nostrPubkey) {
              clearNIP46ConnectionForUser(pubkey);
            }
          });
        } catch (err) {
          console.warn('⚠️ Failed to clear stale connections:', err);
        }
        
        // Validate connection matches logged-in user before saving
        if (connection && connection.pubkey && connection.pubkey !== loginData.user.nostrPubkey) {
          console.warn(`⚠️ LoginModal: Connection pubkey (${connection.pubkey.slice(0, 16)}...) doesn't match logged-in user (${loginData.user.nostrPubkey.slice(0, 16)}...). Not saving connection.`);
        } else {
          // Save user data
          localStorage.setItem('nostr_user', JSON.stringify(loginData.user));
          localStorage.setItem('nostr_login_type', loginType);
          
          // Save preferred signer for better UX on return visits
          const { savePreferredSigner } = await import('@/lib/nostr/nip46-storage');
          savePreferredSigner(loginData.user.nostrPubkey, loginType);
          
          // Save NIP-46/nsecBunker connection
          if (connection) {
            // Ensure connection has the correct pubkey
            connection.pubkey = loginData.user.nostrPubkey;
            
            // Detect if this is a bunker:// connection
            // Bunker connections have signerPubkey set and signerUrl is the bunker:// URI
            const isBunkerConnection = isNsecBunker || (connection as any).signerPubkey || connection.signerUrl?.startsWith('bunker://');
            
            // Log connection details before saving
            console.log('💾 LoginModal: Saving NIP-46 connection:', {
              signerUrl: connection.signerUrl,
              hasToken: !!connection.token,
              tokenLength: connection.token?.length || 0,
              pubkey: connection.pubkey?.slice(0, 16) + '...' || 'N/A',
              connected: connection.connected,
              connectedAt: connection.connectedAt,
              isBunkerConnection,
            });
            
            // Validate connection has required fields
            // For bunker:// connections, token is optional (may be empty)
            if (!connection.signerUrl) {
              console.error('❌ LoginModal: Connection missing required fields:', {
                hasSignerUrl: !!connection.signerUrl,
                hasToken: !!connection.token,
                isBunkerConnection,
              });
              throw new Error('Connection missing required fields. Cannot save.');
            }
            
            // Token is required for non-bunker connections
            if (!isBunkerConnection && !connection.token) {
              console.error('❌ LoginModal: Non-bunker connection missing token:', {
                hasSignerUrl: !!connection.signerUrl,
                hasToken: !!connection.token,
              });
              throw new Error('Connection missing required fields. Cannot save.');
            }
            
            saveNIP46Connection(connection);
            console.log('✅ LoginModal: Connection saved successfully');
          } else {
            console.error('❌ LoginModal: No connection object to save!');
          }
        }
        
        // Register with unified signer
        const signer = getUnifiedSigner();
        await signer.setNIP46Signer(client);

        // Sync favorites to Nostr (fire and forget - don't block login)
        try {
          console.log('🔄 Syncing favorites to Nostr...');
          // Import dynamically to avoid issues with server-side rendering
          import('@/lib/nostr/sync-favorites').then(({ syncFavoritesToNostr }) => {
            syncFavoritesToNostr(loginData.user.id).then((results) => {
              console.log('✅ Favorites synced to Nostr:', results);
            }).catch((err) => {
              console.error('❌ Error syncing favorites:', err);
            });
          }).catch((err) => {
            console.error('❌ Error importing sync module:', err);
          });
        } catch (syncError) {
          // Don't fail login if sync fails
          console.error('❌ Error initiating favorites sync:', syncError);
        }

        // Hide NIP-46 connect UI if still showing
        setShowNip46Connect(false);

        // Close modal and reload (delay to let sync messages show)
        onClose();
        // Preserve wallet connection before reload (Android fix)
        await preserveWalletConnection();
        setTimeout(() => {
          window.location.reload();
        }, 2000); // 2 second delay to see sync messages
      } else {
        throw new Error(loginData.error || 'Login failed');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorDetails = err instanceof Error ? {
        name: err.name,
        message: err.message,
        stack: err.stack,
      } : err;

      console.error('❌ LoginModal: NIP-46 login failed:', {
        error: errorMessage,
        errorDetails,
        connectionState: {
          hasClient: !!client,
          hasConnection: !!client?.getConnection(),
          connectionPubkey: client?.getConnection()?.pubkey?.slice(0, 16) + '...',
        },
      });

      setError(errorMessage || 'Failed to complete NIP-46 login. Please check the error log for details.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // nostr-login handler — launches nostr-login's auth UI, then uses polyfilled window.nostr
  const handleNostrLogin = async () => {
    try {
      setIsSubmitting(true);
      setError(null);

      console.log('🔐 LoginModal: Launching nostr-login auth flow...');

      // Launch nostr-login's auth modal
      document.dispatchEvent(
        new CustomEvent('nlLaunch', { detail: 'welcome' })
      );

      // Wait for nostr-login to complete auth (fires nlAuth event)
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          document.removeEventListener('nlAuth', handler);
          reject(new Error('Login timed out. Please try again.'));
        }, 120000); // 2 minute timeout

        const handler = async (e: Event) => {
          const detail = (e as CustomEvent).detail;
          document.removeEventListener('nlAuth', handler);
          clearTimeout(timeoutId);

          if (detail?.type === 'logout' || !detail) {
            reject(new Error('Login was cancelled'));
            return;
          }

          console.log('✅ nostr-login auth complete, window.nostr is ready');

          try {
            // window.nostr is now polyfilled by nostr-login
            // Run the standard challenge/sign/verify flow
            const { challenge, eventTemplate } = await prepareLoginEvent();

            // Reinitialize the unified signer so it picks up the new window.nostr
            const signer = getUnifiedSigner();
            await signer.reinitialize();

            const signedEvent = await signer.signEvent(eventTemplate as any);
            console.log('✅ LoginModal: Got signed event from nostr-login signer');

            const result = await processSignedLogin(
              signedEvent, challenge, 'extension', onClose
            );
            if (!result.success) {
              throw new Error(result.error || 'Login failed');
            }
            resolve();
          } catch (signErr) {
            reject(signErr);
          }
        };

        document.addEventListener('nlAuth', handler);
      });
    } catch (err) {
      if (err instanceof Error && err.message !== 'Login was cancelled') {
        setError(err.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const modalContent = (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center" 
      style={{ zIndex: 2147483647 }}
      onClick={(e) => {
        // Close modal when clicking backdrop
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div 
        className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl relative max-h-[90vh] overflow-y-auto" 
        style={{ zIndex: 2147483647 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">Sign in with Nostr</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {/* Login Method Tabs */}
        <div className="mb-4 flex gap-2 border-b border-gray-200">
          <button
            onClick={() => setLoginMethod('nostr-login')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              loginMethod === 'nostr-login'
                ? 'border-b-2 border-green-600 text-green-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Sign In
          </button>
          <button
            onClick={() => setLoginMethod('primal')}
            className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
              loginMethod === 'primal'
                ? 'border-b-2 border-purple-600 text-purple-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Primal
          </button>
        </div>

        {/* Primal Login (iOS-optimized NIP-46) */}
        {loginMethod === 'primal' && (
          <>
            {/* Loading state while initializing */}
            {isInitializingAmber && !showNip46Connect && (
              <div className="mb-4 flex flex-col items-center gap-3 py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                <p className="text-sm text-gray-600">Preparing Primal connection...</p>
              </div>
            )}

            {/* Error state with retry */}
            {amberConnectionError && !showNip46Connect && !isInitializingAmber && (
              <div className="mb-4">
                <div className="p-3 bg-red-100 border border-red-400 text-red-700 rounded mb-3">
                  {amberConnectionError}
                </div>
                <button
                  onClick={() => {
                    setAmberConnectionError(null);
                    setAmberConnectionInitialized(false);
                  }}
                  className="w-full px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700"
                >
                  Retry Connection
                </button>
              </div>
            )}

            {/* QR Code / Connection UI */}
            {showNip46Connect && (
              <Nip46Connect
                connectionToken={nip46ConnectionToken}
                signerUrl={nip46SignerUrl}
                signerApp="primal"
                onConnected={() => {
                  setShowNip46Connect(false);
                  handleNip46Connected();
                }}
                onError={(error) => {
                  setError(error);
                  setIsSubmitting(false);
                  setShowNip46Connect(false);
                  setAmberConnectionInitialized(false);
                }}
                onCancel={() => {
                  cleanupAmberConnection();
                }}
              />
            )}

            {/* iOS recommendation note */}
            {!isInitializingAmber && !amberConnectionError && !showNip46Connect && (
              <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded-md">
                <p className="text-xs text-purple-800">
                  <strong>Best for iOS:</strong> Primal auto-signs with Full trust and responds near-instantly. Great for iPhone and iPad users.
                </p>
              </div>
            )}
          </>
        )}

        {/* nostr-login (works on iOS + any platform without extensions) */}
        {loginMethod === 'nostr-login' && (
          <div className="mb-4">
            <button
              onClick={handleNostrLogin}
              disabled={isSubmitting}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {isSubmitting ? 'Signing in...' : '🔑 Sign In to Nostr'}
            </button>
            <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-md">
              <p className="text-xs text-green-800">
                <strong>Works everywhere:</strong> Create a new key, paste your nsec, or connect to a bunker. No app or extension required — keys are managed securely in your browser.
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  // Render in portal to ensure it's above everything
  if (!mounted || typeof window === 'undefined') {
    return null;
  }

  return createPortal(modalContent, document.body);
}

