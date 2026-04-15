/**
 * Login diagnostics — mobile-friendly capture for Nostr sign-in failures.
 *
 * Purpose: iOS/Android users can't easily open DevTools to grab console logs
 * when login hangs or errors. This module:
 *   1. Installs a lightweight console.log/warn/error tee that feeds a ring
 *      buffer while the LoginModal is open.
 *   2. Builds a self-contained text report (environment, modal state,
 *      NIP-46 connection state, redacted URLs, last 200 log lines) that the
 *      user can copy to clipboard and paste into a bug report.
 *
 * Secrets are redacted: tokens, private keys, and the `secret=` query
 * parameter inside bunker:// and nostrconnect:// URIs are all stripped.
 */

const MAX_LOG_ENTRIES = 200;
const MAX_MSG_LENGTH = 2000;

type LogLevel = 'log' | 'warn' | 'error';

interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

const buffer: LogEntry[] = [];

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (key, val) => {
      // Redact obvious secret fields regardless of depth.
      if (
        typeof val === 'string' &&
        (key === 'token' ||
          key === 'secret' ||
          key === 'privateKey' ||
          key === 'nsec' ||
          key === 'sig')
      ) {
        if (val.length === 0) return val;
        return `[REDACTED len=${val.length}]`;
      }
      return val;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
  }
  return safeStringify(arg);
}

export function pushLog(level: LogLevel, args: unknown[]): void {
  try {
    const msg = args.map(formatArg).join(' ').slice(0, MAX_MSG_LENGTH);
    buffer.push({ t: Date.now(), level, msg });
    if (buffer.length > MAX_LOG_ENTRIES) {
      buffer.splice(0, buffer.length - MAX_LOG_ENTRIES);
    }
  } catch {
    // Never let diagnostics break the app.
  }
}

export function clearLogs(): void {
  buffer.length = 0;
}

export function getLogs(): LogEntry[] {
  return buffer.slice();
}

// ---------- Console capture (ref-counted, safe to call from multiple modals) ----------

let patchCount = 0;
let original: {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
} | null = null;

export function installConsoleCapture(): void {
  if (typeof console === 'undefined') return;
  if (patchCount === 0) {
    original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    console.log = (...args: unknown[]) => {
      pushLog('log', args);
      original!.log(...args);
    };
    console.warn = (...args: unknown[]) => {
      pushLog('warn', args);
      original!.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      pushLog('error', args);
      original!.error(...args);
    };
  }
  patchCount++;
}

export function uninstallConsoleCapture(): void {
  if (typeof console === 'undefined') return;
  patchCount = Math.max(0, patchCount - 1);
  if (patchCount === 0 && original) {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    original = null;
  }
}

// ---------- Snapshot / report ----------

function redactUrl(url: string | null | undefined): string {
  if (!url) return '(none)';
  try {
    if (url.startsWith('bunker://') || url.startsWith('nostrconnect://')) {
      const scheme = url.startsWith('bunker://') ? 'bunker' : 'nostrconnect';
      const parsed = new URL(url.replace(/^(bunker|nostrconnect):\/\//, 'http://'));
      if (parsed.searchParams.has('secret')) {
        parsed.searchParams.set('secret', '[REDACTED]');
      }
      return `${scheme}://${parsed.host}${parsed.pathname}${parsed.search}`;
    }
    return url;
  } catch {
    return url.replace(/secret=[^&]+/gi, 'secret=[REDACTED]');
  }
}

function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  const parts: string[] = [];
  if (/iPhone|iPad|iPod/.test(ua)) parts.push('iOS');
  if (/Android/.test(ua)) parts.push('Android');
  if (/Safari/.test(ua) && !/Chrome|CriOS/.test(ua)) parts.push('Safari');
  if (/Chrome|CriOS/.test(ua)) parts.push('Chrome');
  if (/Firefox|FxiOS/.test(ua)) parts.push('Firefox');
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(display-mode: standalone)')?.matches
  ) {
    parts.push('PWA');
  }
  return parts.length ? parts.join(' / ') : 'unknown';
}

export interface DiagnosticsSnapshotInput {
  error: string | null;
  view?: string;
  loginMethod?: string;
  isSubmitting?: boolean;
  hasExtension?: boolean;
  showNip46Connect?: boolean;
  isInitializingAmber?: boolean;
  amberConnectionError?: string | null;
  /** Pass the NIP46Client instance if available (we only read public getters). */
  nip46Client?: {
    isConnected?: () => boolean;
    getConnection?: () => unknown;
  } | null;
  modalOpenedAt?: number;
}

export function buildDiagnosticsReport(input: DiagnosticsSnapshotInput): string {
  const lines: string[] = [];
  const now = Date.now();

  lines.push('=== Stablekraft Nostr Login Diagnostics ===');
  lines.push(`Captured: ${new Date(now).toISOString()}`);
  if (input.modalOpenedAt) {
    lines.push(`Modal open for: ${((now - input.modalOpenedAt) / 1000).toFixed(1)}s`);
  }
  lines.push('');

  lines.push('-- Environment --');
  if (typeof navigator !== 'undefined') {
    lines.push(`platform: ${detectPlatform()}`);
    lines.push(`userAgent: ${navigator.userAgent}`);
    lines.push(`language: ${navigator.language}`);
    lines.push(`online: ${navigator.onLine}`);
  }
  if (typeof window !== 'undefined') {
    lines.push(`window.nostr present: ${!!(window as any).nostr}`);
    lines.push(`location: ${window.location?.origin || '(ssr)'}`);
  }
  lines.push('');

  lines.push('-- Modal state --');
  lines.push(`view: ${input.view ?? '?'}`);
  lines.push(`loginMethod: ${input.loginMethod ?? '?'}`);
  lines.push(`isSubmitting: ${input.isSubmitting ?? '?'}`);
  lines.push(`hasExtension: ${input.hasExtension ?? '?'}`);
  lines.push(`showNip46Connect: ${input.showNip46Connect ?? '?'}`);
  lines.push(`isInitializingAmber: ${input.isInitializingAmber ?? '?'}`);
  lines.push(`amberConnectionError: ${input.amberConnectionError ?? '(none)'}`);
  lines.push(`error: ${input.error ?? '(none)'}`);
  lines.push('');

  lines.push('-- LocalStorage flags --');
  try {
    lines.push(`nostr_login_type: ${localStorage.getItem('nostr_login_type') ?? '(none)'}`);
    lines.push(`nostr_user present: ${!!localStorage.getItem('nostr_user')}`);
    lines.push(
      `nostr_nip46_connection present: ${!!localStorage.getItem('nostr_nip46_connection')}`,
    );
    lines.push(
      `nostr_nip46_connections_by_pubkey present: ${!!localStorage.getItem('nostr_nip46_connections_by_pubkey')}`,
    );
    lines.push(`nip46_debug: ${localStorage.getItem('nip46_debug') ?? 'false'}`);
  } catch (err) {
    lines.push(`(localStorage unavailable: ${err instanceof Error ? err.message : String(err)})`);
  }
  lines.push('');

  lines.push('-- NIP-46 client --');
  const client = input.nip46Client;
  if (client) {
    try {
      const connection = (client.getConnection?.() ?? null) as any;
      lines.push('hasClient: true');
      lines.push(`isConnected: ${client.isConnected?.() ?? '?'}`);
      if (connection) {
        lines.push(`connection.connected: ${connection.connected ?? '?'}`);
        lines.push(`connection.pubkey present: ${!!connection.pubkey}`);
        lines.push(`connection.signerUrl: ${redactUrl(connection.signerUrl)}`);
        lines.push(`connection.relayUrl: ${redactUrl(connection.relayUrl)}`);
        lines.push(`connection.token present: ${!!connection.token}`);
        lines.push(`connection.signerPubkey present: ${!!connection.signerPubkey}`);
        lines.push(`connection.signerAppPubkey present: ${!!connection.signerAppPubkey}`);
        lines.push(
          `connection.connectedAt: ${
            connection.connectedAt
              ? new Date(connection.connectedAt).toISOString()
              : '(never)'
          }`,
        );
      } else {
        lines.push('connection: (none)');
      }
    } catch (err) {
      lines.push(`(error reading client: ${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    lines.push('hasClient: false');
  }
  lines.push('');

  lines.push(`-- Recent logs (${buffer.length} entries, newest last) --`);
  const baseT = input.modalOpenedAt ?? buffer[0]?.t ?? now;
  for (const entry of buffer) {
    const rel = `+${((entry.t - baseT) / 1000).toFixed(2)}s`;
    lines.push(`[${rel}] [${entry.level}] ${entry.msg}`);
  }
  if (buffer.length === 0) {
    lines.push('(no log entries captured)');
  }

  return lines.join('\n');
}
