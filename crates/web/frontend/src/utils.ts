// ============================================================================
// Utility functions for DOM manipulation, escaping, etc.
// ============================================================================

/**
 * Get element by ID (shorthand)
 */
export function ge(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Escape HTML special characters
 */
export function esc(text: string | null | undefined): string {
  if (!text) return '';
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Format number with 2 decimal places
 */
export function fmt2(n: number): string {
  return Number(n).toFixed(2);
}

/**
 * Format number with 4 decimal places
 */
export function fmt4(n: number): string {
  return Number(n).toFixed(4);
}

/**
 * Format large numbers with K, M, B suffixes
 */
export function fmtNum(n: number): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/**
 * Get current timestamp in ISO 8601 format with milliseconds
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Log with timestamp
 */
export function log(...args: any[]): void {
  console.log(`[${now()}]`, ...args);
}

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Normalize market/symbol names to uppercase
 */
export function normalizeMarketName(name: string): string {
  return String(name || '').trim().toUpperCase();
}

/**
 * Calculate exponential backoff with jitter
 */
export function nextReconnectDelay(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 15000,
  jitterMs: number = 600
): number {
  const cappedAttempt = Math.max(0, Math.min(8, Number(attempt) || 0));
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, cappedAttempt));
  const jitter = Math.floor(Math.random() * jitterMs);
  return exponential + jitter;
}

/**
 * Parse JSON safely
 */
export function safeJsonParse<T = unknown>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/**
 * Stringify JSON safely
 */
export function safeJsonStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '';
  }
}
