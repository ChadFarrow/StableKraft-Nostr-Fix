/**
 * Device detection utilities
 * Detects Android devices and app runtime environment
 */

/**
 * Check if the current device is Android
 * @returns true if running on Android device
 */
export function isAndroid(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  return /android/i.test(userAgent);
}

/**
 * Check if the current device is iOS (iPhone, iPad, iPod)
 * @returns true if running on iOS device
 */
export function isIOS(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;

  // Check for iOS devices
  const isIOSDevice = /iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream;

  // Check for iPad on iOS 13+ which reports as Mac
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  return isIOSDevice || isIPadOS;
}

/**
 * Check if running in a Trusted Web Activity (TWA)
 * @returns true if running in TWA
 */
export function isTWA(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  // TWA detection: check for display-mode or referrer
  const displayMode = (window.matchMedia('(display-mode: standalone)').matches) ||
                      (window.matchMedia('(display-mode: fullscreen)').matches);
  
  // Check for TWA-specific indicators
  const isTWA = displayMode && isAndroid();
  
  return isTWA;
}

/**
 * Check if running in Capacitor
 * @returns true if running in Capacitor
 */
export function isCapacitor(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return !!(window as any).Capacitor;
}

/**
 * Check if running as a PWA
 * @returns true if running as installed PWA
 */
export function isPWA(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  // Check if running in standalone mode (installed PWA)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       (window.navigator as any).standalone ||
                       document.referrer.includes('android-app://');

  return isStandalone;
}

/**
 * Check if the current browser is Brave
 * @returns true if running in Brave browser
 */
export function isBrave(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  // Brave exposes navigator.brave with isBrave() method (async, but presence is sync)
  if ((navigator as any).brave) {
    return true;
  }

  // Fallback: check user agent (some versions include "Brave")
  const userAgent = navigator.userAgent || '';
  return /Brave/i.test(userAgent);
}

/**
 * Build a callback URL that returns the user to their current browser on iOS.
 * Non-Safari iOS browsers (Brave, Firefox, Chrome) need their custom URL scheme
 * so the OS routes the redirect back to the correct app.
 */
export function buildIOSCallbackUrl(targetUrl: string): string {
  if (!isIOS()) {
    return targetUrl;
  }

  if (isBrave()) {
    return `brave://open-url?url=${encodeURIComponent(targetUrl)}`;
  }

  // Firefox iOS
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/FxiOS/i.test(ua)) {
    return `firefox://open-url?url=${encodeURIComponent(targetUrl)}`;
  }

  // Chrome iOS
  if (/CriOS/i.test(ua)) {
    // Chrome uses googlechromes:// for https URLs
    return targetUrl.replace(/^https:\/\//, 'googlechromes://');
  }

  // Safari or unknown — plain https:// works
  return targetUrl;
}

/**
 * Get device information
 * @returns Object with device information
 */
export function getDeviceInfo() {
  return {
    isAndroid: isAndroid(),
    isIOS: isIOS(),
    isTWA: isTWA(),
    isCapacitor: isCapacitor(),
    isPWA: isPWA(),
    userAgent: typeof window !== 'undefined' ? navigator.userAgent : '',
    platform: typeof window !== 'undefined' ? navigator.platform : '',
  };
}

