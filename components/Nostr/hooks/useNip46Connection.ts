'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { NIP46Client } from '@/lib/nostr/nip46-client';

export interface Nip46ConnectionState {
  // Core state
  nip46Client: NIP46Client | null;
  showNip46Connect: boolean;
  nip46ConnectionToken: string;
  nip46SignerUrl: string;

  // Auto-init state
  amberConnectionInitialized: boolean;
  amberConnectionError: string | null;
  isInitializingAmber: boolean;

  // Paste URI state
  pastedConnectionUri: string;
  showPasteUri: boolean;
}

export interface Nip46ConnectionActions {
  // State setters
  setShowNip46Connect: (show: boolean) => void;
  setPastedConnectionUri: (uri: string) => void;
  setShowPasteUri: (show: boolean) => void;
  setAmberConnectionError: (error: string | null) => void;
  setAmberConnectionInitialized: (initialized: boolean) => void;
  setNip46Client: (client: NIP46Client | null) => void;
  setNip46ConnectionToken: (token: string) => void;
  setNip46SignerUrl: (url: string) => void;

  // Actions
  cleanupAmberConnection: () => Promise<void>;
  initializeAmberConnection: () => Promise<void>;

  // Ref access
  nip46ClientRef: React.MutableRefObject<NIP46Client | null>;
}

export interface UseNip46ConnectionOptions {
  loginMethod: 'extension' | 'nip05' | 'amber';
  isSubmitting: boolean;
}

export function useNip46Connection(options: UseNip46ConnectionOptions): Nip46ConnectionState & Nip46ConnectionActions {
  const { loginMethod, isSubmitting } = options;

  // Core NIP-46 state
  const [nip46Client, setNip46Client] = useState<NIP46Client | null>(null);
  const nip46ClientRef = useRef<NIP46Client | null>(null);
  const [showNip46Connect, setShowNip46Connect] = useState(false);
  const [nip46ConnectionToken, setNip46ConnectionToken] = useState<string>('');
  const [nip46SignerUrl, setNip46SignerUrl] = useState<string>('');

  // Auto-init state for Amber connection
  const [amberConnectionInitialized, setAmberConnectionInitialized] = useState(false);
  const [amberConnectionError, setAmberConnectionError] = useState<string | null>(null);
  const [isInitializingAmber, setIsInitializingAmber] = useState(false);

  // Paste URI state
  const [pastedConnectionUri, setPastedConnectionUri] = useState<string>('');
  const [showPasteUri, setShowPasteUri] = useState(false);

  // Cleanup function for Amber connection
  const cleanupAmberConnection = useCallback(async () => {
    if (nip46ClientRef.current) {
      try {
        await nip46ClientRef.current.disconnect();
      } catch (err) {
        console.warn('Failed to disconnect NIP-46 client:', err);
      }
      nip46ClientRef.current = null;
    }
    setNip46Client(null);
    setShowNip46Connect(false);
    setNip46ConnectionToken('');
    setNip46SignerUrl('');
    setAmberConnectionInitialized(false);
    setAmberConnectionError(null);
    setIsInitializingAmber(false);
  }, []);

  // Initialize Amber connection - extracted from handleNip46Connect for auto-init
  const initializeAmberConnection = useCallback(async () => {
    // Check if localStorage is available and persistent
    try {
      const testKey = '_nip46_storage_test';
      localStorage.setItem(testKey, 'test');
      const retrieved = localStorage.getItem(testKey);
      localStorage.removeItem(testKey);

      if (retrieved !== 'test') {
        throw new Error('localStorage is not working properly. You may be in incognito/private mode.');
      }
    } catch (err) {
      throw new Error('localStorage is blocked. You may be in incognito/private mode.');
    }

    // Check for existing valid connection and try to auto-reconnect
    const { hasValidConnection, loadNIP46Connection, clearNIP46Connection } = await import('@/lib/nostr/nip46-storage');
    const { getUnifiedSigner } = await import('@/lib/nostr/signer');

    if (hasValidConnection()) {
      console.log('🔄 NIP-46: Found existing connection, attempting auto-reconnect...');

      // Get current user pubkey for validation
      let currentUserPubkey: string | undefined;
      try {
        const storedUser = localStorage.getItem('nostr_user');
        if (storedUser) {
          const userData = JSON.parse(storedUser);
          currentUserPubkey = userData.nostrPubkey;
        }
      } catch (err) {
        console.warn('⚠️ Failed to get current user pubkey:', err);
      }

      // Load the stored connection (with user pubkey validation)
      const storedConnection = loadNIP46Connection(currentUserPubkey);
      if (storedConnection && storedConnection.pubkey) {
        // Validate connection matches current user
        if (currentUserPubkey && storedConnection.pubkey !== currentUserPubkey) {
          throw new Error('Stored connection is for a different user. Please reconnect.');
        }
        // Create client and restore connection
        const client = new NIP46Client();

        // Manually set the connection data from storage
        (client as any).connection = storedConnection;

        setNip46Client(client);
        nip46ClientRef.current = client;

        // Register with unified signer
        const signer = getUnifiedSigner();
        await signer.setNIP46Signer(client);

        console.log('✅ NIP-46: Auto-reconnect successful');

        // Set state to show we're ready (but don't show QR - we'll auto-login)
        setShowNip46Connect(true);
        return;
      }
    }

    // Clear any existing connections to start fresh
    clearNIP46Connection();

    // Disconnect any active NIP-46 signer in UnifiedSigner
    const signer = getUnifiedSigner();
    try {
      await signer.disconnectNIP46();
    } catch (err) {
      console.log('ℹ️ NIP-46: No active connection to disconnect');
    }

    // Clean up any existing client connection
    if (nip46ClientRef.current) {
      try {
        await nip46ClientRef.current.disconnect();
      } catch (err) {
        console.warn('Failed to disconnect existing client:', err);
      }
      nip46ClientRef.current = null;
    }
    setNip46Client(null);

    // Get or create a persistent app key pair
    const { getOrCreateAppKeyPair } = await import('@/lib/nostr/nip46-storage');
    const keyPair = getOrCreateAppKeyPair();
    const { privateKey, publicKey } = keyPair;

    // Get default relay for connection
    const { getDefaultRelays } = await import('@/lib/nostr/relay');
    const relays = getDefaultRelays();
    const preferredRelays = relays.filter(r => !r.includes('relay.damus.io') && !r.includes('relay.nsec.app'));
    const relayUrl = preferredRelays[0] || 'wss://nos.lol';

    // Generate connection token
    const token = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    // Store connection info temporarily in sessionStorage
    const connectionInfo = {
      token,
      privateKey,
      publicKey,
      relayUrl,
      createdAt: Date.now(),
    };
    sessionStorage.setItem('nip46_pending_connection', JSON.stringify(connectionInfo));

    // Initialize NIP-46 client
    const client = new NIP46Client();
    nip46ClientRef.current = client;
    setNip46Client(client);

    // Set up connection callback
    client.setOnConnection((signerPubkey: string) => {
      console.log('✅ NIP-46: Connection established with signer:', signerPubkey);
    });

    // Start listening on relay for connection
    try {
      await client.connect(relayUrl, token, true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('❌ initializeAmberConnection: Failed to start relay connection:', errorMessage);
      throw new Error(`Failed to connect to relay: ${errorMessage}`);
    }

    // Generate nostrconnect URI
    const relayEncoded = encodeURIComponent(relayUrl);
    const secretEncoded = encodeURIComponent(token);
    const appName = encodeURIComponent('StableKraft');
    const appUrl = encodeURIComponent('https://stablekraft.app/');
    const nostrconnectUri = `nostrconnect://${publicKey}?relay=${relayEncoded}&secret=${secretEncoded}&name=${appName}&url=${appUrl}`;

    console.log('NIP-46: Generated connection URI for relay:', relayUrl);

    setNip46ConnectionToken(nostrconnectUri);
    setNip46SignerUrl(relayUrl);
    setShowNip46Connect(true);
  }, []);

  // Auto-initialize Amber connection when tab is selected
  useEffect(() => {
    let cancelled = false;

    const initConnection = async () => {
      if (loginMethod === 'amber' && !amberConnectionInitialized && !showPasteUri && !isSubmitting && !isInitializingAmber) {
        setIsInitializingAmber(true);
        setAmberConnectionError(null);

        try {
          await initializeAmberConnection();
          if (!cancelled) {
            setAmberConnectionInitialized(true);
          }
        } catch (err) {
          if (!cancelled) {
            setAmberConnectionError(err instanceof Error ? err.message : 'Failed to initialize connection');
          }
        } finally {
          if (!cancelled) {
            setIsInitializingAmber(false);
          }
        }
      }
    };

    initConnection();

    return () => {
      cancelled = true;
    };
  }, [loginMethod, amberConnectionInitialized, showPasteUri, isSubmitting, isInitializingAmber, initializeAmberConnection]);

  // Cleanup when switching away from Amber tab
  useEffect(() => {
    if (loginMethod !== 'amber' && amberConnectionInitialized) {
      cleanupAmberConnection();
    }
  }, [loginMethod, amberConnectionInitialized, cleanupAmberConnection]);

  return {
    // State
    nip46Client,
    showNip46Connect,
    nip46ConnectionToken,
    nip46SignerUrl,
    amberConnectionInitialized,
    amberConnectionError,
    isInitializingAmber,
    pastedConnectionUri,
    showPasteUri,

    // Setters
    setShowNip46Connect,
    setPastedConnectionUri,
    setShowPasteUri,
    setAmberConnectionError,
    setAmberConnectionInitialized,
    setNip46Client,
    setNip46ConnectionToken,
    setNip46SignerUrl,

    // Actions
    cleanupAmberConnection,
    initializeAmberConnection,

    // Ref
    nip46ClientRef,
  };
}
