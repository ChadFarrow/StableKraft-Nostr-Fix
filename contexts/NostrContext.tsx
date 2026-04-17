'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
// Note: nostr-tools functions are imported via @/lib/nostr/keys when needed (lazy-loaded)
import { fetchAndStoreUserRelays, clearStoredUserRelays } from '@/lib/nostr/nip65';
import { normalizePubkey } from '@/lib/nostr/normalize';
import { installConsoleCapture, uninstallConsoleCapture } from '@/lib/nostr/login-diagnostics';

export interface NostrUser {
  id: string;
  nostrPubkey: string;
  nostrNpub: string;
  displayName?: string;
  avatar?: string;
  bio?: string;
  lightningAddress?: string;
  relays: string[];
  nip05Verified?: boolean;
  loginType?: 'extension' | 'nip05' | 'nip46' | 'nip55' | 'nsecbunker'; // Track login method
}

interface NostrContextType {
  user: NostrUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => void;
  updateUser: (updates: Partial<NostrUser>) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const NostrContext = createContext<NostrContextType>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  logout: () => {},
  updateUser: async () => {},
  refreshUser: async () => {},
});

const NOSTR_USER_KEY = 'nostr_user';

export function NostrProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<NostrUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Keep the diagnostics console tee installed for the lifetime of a logged-in
  // session so post-login console.log calls from nip46-client / publish-queue
  // land in the ring buffer the UserMenu "Copy diagnostics" button reads.
  // installConsoleCapture is ref-counted, so it composes safely with the
  // separate install/uninstall LoginModal does on its own mount/unmount.
  useEffect(() => {
    if (!user) return;
    installConsoleCapture();
    return () => {
      uninstallConsoleCapture();
    };
  }, [user]);

  // Run any favorites sync that was deferred from a login flow. The previous
  // pattern fired sync before window.location.reload(), which aborted the
  // in-flight fetches. Now completeLogin / NIP-46 login sets a localStorage
  // flag and we pick it up here on the stable post-reload page.
  useEffect(() => {
    if (!user?.id) return;
    const pendingUserId = localStorage.getItem('nostr_pending_favorites_sync');
    if (!pendingUserId || pendingUserId !== user.id) return;

    // Clear the flag first so we don't re-trigger if this effect re-runs.
    localStorage.removeItem('nostr_pending_favorites_sync');

    console.log('🔄 Running deferred favorites sync to Nostr...');
    import('@/lib/nostr/sync-favorites')
      .then(({ syncFavoritesToNostr }) => syncFavoritesToNostr(user.id))
      .then((results) => {
        if (!results) return;
        if (results.interrupted) return; // already warned inside
        console.log('✅ Favorites synced to Nostr:', results);
      })
      .catch((err) => console.error('❌ Error running deferred favorites sync:', err));
  }, [user?.id]);

  // Load user from localStorage on mount
  useEffect(() => {
    try {
      const storedUser = localStorage.getItem(NOSTR_USER_KEY);

      if (process.env.NODE_ENV === 'development') {
        console.log('🔐 NostrContext: Loading from localStorage', {
          hasUser: !!storedUser,
        });
      }

      // Load user (extension or NIP-05 login)
      if (storedUser) {
        try {
          const userData = JSON.parse(storedUser);
          if (userData.nostrPubkey) {
            const hex = normalizePubkey(userData.nostrPubkey);
            if (hex) userData.nostrPubkey = hex;
          }
          // Get login type from localStorage
          const loginType = localStorage.getItem('nostr_login_type') as 'extension' | 'nip05' | 'nip46' | 'nip55' | 'nsecbunker' | null;
          if (loginType) {
            userData.loginType = loginType;
          }
          setUser(userData);
          
          if (process.env.NODE_ENV === 'development') {
            console.log('✅ NostrContext: User loaded from localStorage', {
              userId: userData.id,
              npub: userData.nostrNpub?.slice(0, 16) + '...',
              loginType: userData.loginType || 'extension',
            });
          }

          // Fetch user's NIP-65 relay list in the background
          if (userData.nostrPubkey) {
            fetchAndStoreUserRelays(userData.nostrPubkey).then((relays) => {
              if (relays) {
                console.log(`✅ NostrContext: Fetched ${relays.write.length} write relays for user`);
              }
            }).catch((err) => {
              console.warn('⚠️ NostrContext: Failed to fetch user relays:', err);
            });
          }

          // Backfill profile metadata (displayName/avatar/bio/lightningAddress)
          // from kind-0 if the stored record has it missing. The login route
          // returns null profile fields so login can complete in ~20ms; we
          // populate them here post-reload instead of on the critical path.
          if (userData.nostrPubkey && !userData.displayName) {
            import('@/lib/nostr/profile')
              .then(({ fetchUserProfile }) => fetchUserProfile(userData.nostrPubkey))
              .then((profile) => {
                if (!profile) return;
                const displayName = profile.display_name || profile.name || null;
                const avatar = profile.picture || null;
                const bio = profile.about || null;
                const lightningAddress = profile.lud16 || profile.lud06 || null;
                if (!displayName && !avatar && !bio && !lightningAddress) return;

                setUser((prev) => {
                  if (!prev || prev.nostrPubkey !== userData.nostrPubkey) return prev;
                  const merged: NostrUser = {
                    ...prev,
                    displayName: prev.displayName || displayName || undefined,
                    avatar: prev.avatar || avatar || undefined,
                    bio: prev.bio || bio || undefined,
                    lightningAddress: prev.lightningAddress || lightningAddress || undefined,
                  };
                  try {
                    localStorage.setItem(NOSTR_USER_KEY, JSON.stringify(merged));
                  } catch {}
                  return merged;
                });

                if (process.env.NODE_ENV === 'development') {
                  console.log('✅ NostrContext: Backfilled profile from Nostr', {
                    displayName,
                    hasAvatar: !!avatar,
                  });
                }
              })
              .catch((err) => {
                console.warn('⚠️ NostrContext: Failed to backfill profile:', err);
              });
          }
        } catch (parseError) {
          console.error('❌ NostrContext: Failed to parse user data:', parseError);
        }
      } else {
        if (process.env.NODE_ENV === 'development') {
          console.log('ℹ️ NostrContext: No stored user found');
        }
      }
    } catch (error) {
      console.error('❌ NostrContext: Error loading user from localStorage:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Sync user with server - fetches from Nostr relays first (source of truth)
  const refreshUser = useCallback(async () => {
    if (!user) return;

    try {
      const response = await fetch('/api/nostr/auth/me', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-nostr-user-id': user.id, // Send user ID to fetch from Nostr relays
        },
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.user) {
          if (data.user.nostrPubkey) {
            const { normalizePubkey } = await import('@/lib/nostr/normalize');
            const hex = normalizePubkey(data.user.nostrPubkey);
            if (hex) data.user.nostrPubkey = hex;
          }
          if (data.user.nostrPubkey) {
            const { normalizePubkey } = await import('@/lib/nostr/normalize');
            const hex = normalizePubkey(data.user.nostrPubkey);
            if (hex) data.user.nostrPubkey = hex;
          }
          // Preserve loginType from localStorage if not in response
          const storedLoginType = localStorage.getItem('nostr_login_type') as 'extension' | 'nip05' | 'nip46' | 'nip55' | 'nsecbunker' | null;
          if (storedLoginType && !data.user.loginType) {
            data.user.loginType = storedLoginType;
          }
          setUser(data.user);
          localStorage.setItem(NOSTR_USER_KEY, JSON.stringify(data.user));
        }
      }
    } catch (error) {
      console.error('Error refreshing Nostr user:', error);
    }
  }, [user]);


  // Logout
  const logout = useCallback(() => {
    localStorage.removeItem(NOSTR_USER_KEY);
    localStorage.removeItem('nostr_login_type'); // Remove login type
    clearStoredUserRelays(); // Clear NIP-65 relay list
    setUser(null);

    // Clean up NIP-46 signer and connection state so the next login starts fresh
    import('@/lib/nostr/signer').then(({ resetUnifiedSigner }) => {
      resetUnifiedSigner().catch(err => {
        console.warn('Failed to reset signer on logout:', err);
      });
    }).catch(err => {
      console.warn('Failed to import signer module on logout:', err);
    });

    // Clear saved NIP-46 connection data from localStorage
    import('@/lib/nostr/nip46-storage').then(({ clearNIP46Connection }) => {
      clearNIP46Connection();
    }).catch(err => {
      console.warn('Failed to clear NIP-46 connection on logout:', err);
    });

    // Call logout API
    fetch('/api/nostr/auth/logout', {
      method: 'POST',
      credentials: 'include',
    }).catch(err => {
      console.error('Logout API error:', err);
    });
  }, []);

  // Update user
  const updateUser = useCallback(async (updates: Partial<NostrUser>) => {
    if (!user) return;

    try {
      const response = await fetch('/api/nostr/profile/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.user) {
          // Preserve loginType when updating
          const currentLoginType = user?.loginType || localStorage.getItem('nostr_login_type') as 'extension' | 'nip05' | 'nip46' | 'nip55' | 'nsecbunker' | null;
          if (currentLoginType && !data.user.loginType) {
            data.user.loginType = currentLoginType;
          }
          setUser(data.user);
          localStorage.setItem(NOSTR_USER_KEY, JSON.stringify(data.user));
        }
      }
    } catch (error) {
      console.error('Error updating user:', error);
      throw error;
    }
  }, [user]);

  return (
    <NostrContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        logout,
        updateUser,
        refreshUser,
      }}
    >
      {children}
    </NostrContext.Provider>
  );
}

export function useNostr() {
  const context = useContext(NostrContext);

  if (context === undefined) {
    throw new Error('useNostr must be used within a NostrProvider');
  }

  return context;
}

