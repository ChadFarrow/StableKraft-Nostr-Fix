/**
 * Nudge-toast wrapper for long-running Nostr signer operations.
 *
 * NIP-46 sign/getPublicKey calls go over a relay to the user's signer app
 * (Amber, Primal, nsec.app, …). When the user backgrounds the signer or
 * ignores the approval prompt, the call can sit silently for tens of
 * seconds — no on-screen cue that the app is waiting. This helper shows a
 * dismissable toast after a short grace period reminding the user to
 * approve in their signer, and enforces a hard timeout so we never hang
 * indefinitely.
 *
 * Pattern adapted from soapbox-pub/ditto's signerWithNudge.ts.
 */

import { toast } from '@/components/Toast';

const NUDGE_DELAY_MS = 4_000;
// Must sit OUTSIDE the underlying NIP-46 client's 120s relay-request timeout
// (see `sendRelayRequest` in lib/nostr/nip46-client.ts). A shorter wrapper
// timeout pre-empts the client's richer error and breaks legitimate slow
// signers — Primal on iOS PWA in particular routinely takes 30-90s for the
// full publish → wake signer → approve → relay-deliver-response round-trip,
// especially after iOS kills the WebSocket while the user is in the signer
// app. Keep this slightly longer than the client's 120s so the underlying
// timeout (with its troubleshooting tips) fires first; the wrapper is just
// a safety net for cases where the underlying promise never settles.
const HARD_TIMEOUT_MS = 125_000;

/** Throttle: don't show another nudge toast within this window. */
const NUDGE_THROTTLE_MS = 8_000;
let lastNudgeShownAt = 0;

export type SignerOp = 'sign' | 'getPublicKey' | 'encrypt' | 'decrypt' | 'connect';

interface NudgeOptions {
  /** Short label for the signer (e.g., 'Primal', 'Amber', 'nsec.app'). */
  signerLabel?: string;
  /** The operation being awaited — used to compose the toast message. */
  op?: SignerOp;
}

function messageFor(op: SignerOp | undefined, signerLabel: string): string {
  const label = signerLabel || 'your signer';
  switch (op) {
    case 'sign':
      return `Waiting on ${label} to approve signing…`;
    case 'encrypt':
    case 'decrypt':
      return `Waiting on ${label} to finish encryption…`;
    case 'connect':
      return `Waiting for ${label} to connect…`;
    case 'getPublicKey':
      return `Waiting on ${label} to share your pubkey…`;
    default:
      return `Waiting on ${label} — check the app to approve.`;
  }
}

/**
 * Run a signer operation with a nudge toast after NUDGE_DELAY_MS and a
 * hard timeout at HARD_TIMEOUT_MS. Returns the op's result, or rejects
 * with an error if the timeout fires.
 */
export async function withSignerNudge<T>(
  op: () => Promise<T>,
  options: NudgeOptions = {},
): Promise<T> {
  let toastId: string | null = null;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (nudgeTimer) clearTimeout(nudgeTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (toastId) {
      toast.dismiss(toastId);
      toastId = null;
    }
  };

  const scheduleNudge = () => {
    nudgeTimer = setTimeout(() => {
      const now = Date.now();
      if (now - lastNudgeShownAt < NUDGE_THROTTLE_MS) return;
      lastNudgeShownAt = now;
      toastId = toast.info(messageFor(options.op, options.signerLabel || ''), {
        // Long duration: the toast sticks until cleanup() or the user dismisses it
        duration: HARD_TIMEOUT_MS,
      });
    }, NUDGE_DELAY_MS);
  };

  const timeoutPromise = new Promise<T>((_, reject) => {
    hardTimer = setTimeout(() => {
      reject(new Error('Signer request timed out. Please try again.'));
    }, HARD_TIMEOUT_MS);
  });

  scheduleNudge();

  try {
    const result = await Promise.race([op(), timeoutPromise]);
    return result;
  } finally {
    cleanup();
  }
}
