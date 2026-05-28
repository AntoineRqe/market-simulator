// ============================================================================
// Authentication and session management
// ============================================================================

import { getLoginGatewayUrl } from './constants.js';
import {
  safeJsonParse,
  safeJsonStringify,
} from './utils.js';
import type { MarketTokens } from './types.js';

/**
 * Initialize authentication from URL parameters and session storage
 */
export function initializeAuth(): void {
  const params = new URLSearchParams(window.location.search);
  const tokenFromQuery = params.get('token');
  const usernameFromQuery = params.get('username');
  const passwordFromQuery = params.get('password');
  const adminFromQuery = params.get('is_admin');

  // Always save username if provided (for multi-market gateway responses)
  if (usernameFromQuery) {
    sessionStorage.setItem('auth_username', usernameFromQuery);
  }

  if (tokenFromQuery) {
    sessionStorage.setItem('auth_token', tokenFromQuery);
    if (passwordFromQuery) {
      sessionStorage.setItem('auth_password', passwordFromQuery);
    }
    if (adminFromQuery !== null) {
      sessionStorage.setItem('auth_is_admin', adminFromQuery);
    }
    // Remove secrets from URL after one-time handoff
    history.replaceState({}, '', '/app');
  }
}

/**
 * Get stored authentication token
 */
export function getAuthToken(): string | null {
  return sessionStorage.getItem('auth_token');
}

/**
 * Get stored username
 */
export function getUsername(): string | null {
  return sessionStorage.getItem('auth_username');
}

/**
 * Get stored password
 */
export function getPassword(): string | null {
  return sessionStorage.getItem('auth_password');
}

/**
 * Check if user is admin
 */
export function isAdmin(): boolean {
  return sessionStorage.getItem('auth_is_admin') === 'true';
}

/**
 * Set authentication token
 */
export function setAuthToken(token: string): void {
  sessionStorage.setItem('auth_token', token);
}

/**
 * Set username
 */
export function setUsername(username: string): void {
  sessionStorage.setItem('auth_username', username);
}

/**
 * Set admin flag
 */
export function setAdmin(isAdmin: boolean): void {
  sessionStorage.setItem('auth_is_admin', isAdmin ? 'true' : 'false');
}

/**
 * Clear all authentication data
 */
export function clearAuth(): void {
  sessionStorage.removeItem('auth_token');
  sessionStorage.removeItem('auth_username');
  sessionStorage.removeItem('auth_password');
  sessionStorage.removeItem('auth_is_admin');
  sessionStorage.removeItem('market_tokens');
}

/**
 * Get market tokens from multi-market auth
 */
export function getMarketTokens(): MarketTokens {
  const stored = sessionStorage.getItem('market_tokens');
  return safeJsonParse<MarketTokens>(stored || '{}', {});
}

/**
 * Set market tokens for multi-market auth
 */
export function setMarketTokens(tokens: MarketTokens): void {
  sessionStorage.setItem('market_tokens', safeJsonStringify(tokens));
}

/**
 * Normalize URLs for market tokens (handles HTTPS proxying)
 */
export function normalizeMarketTokenUrls(tokens: MarketTokens | null): MarketTokens {
  if (!tokens || typeof tokens !== 'object') return {};

  const normalized: MarketTokens = {};
  let changed = false;

  Object.keys(tokens).forEach((name) => {
    const entry = tokens[name] || {};
    let url = String(entry.url || '').trim();

    if (location.protocol === 'https:' && url) {
      try {
        const parsed = new URL(url, location.origin);
        const sameHost = parsed.hostname === location.hostname;
        const mappedPort =
          parsed.port === '9870' ||
          parsed.port === '9885' ||
          parsed.port === '19870' ||
          parsed.port === '19885';
        if (sameHost && mappedPort) {
          const marketPath = encodeURIComponent(
            String(name || '').trim().toLowerCase()
          );
          if (marketPath) {
            const rewritten = `${location.origin}/${marketPath}`;
            if (rewritten !== url) changed = true;
            url = rewritten;
          }
        }
      } catch {
        // Ignore URL parsing errors
      }
    }

    normalized[name] = {
      ...entry,
      url,
    };
  });

  if (changed) {
    try {
      setMarketTokens(normalized);
      console.log('[Auth] Normalized stale market token URLs for HTTPS.');
    } catch {
      // Ignore storage errors
    }
  }

  return normalized;
}

/**
 * Check if user has valid authentication
 */
export function isAuthenticatedAndAuthorized(): boolean {
  const token = getAuthToken();
  const marketTokens = getMarketTokens();
  const hasMultiMarketAuth = marketTokens && Object.keys(marketTokens).length > 0;

  if (!token && !hasMultiMarketAuth) {
    return false;
  }

  return true;
}

/**
 * Require authentication; redirect to login gateway if not authenticated
 */
export function requireAuth(): void {
  if (!isAuthenticatedAndAuthorized()) {
    location.replace(getLoginGatewayUrl() || '/');
  }
}

/**
 * Logout user and return to login
 */
export function logout(): void {
  clearAuth();
  location.replace(getLoginGatewayUrl() || '/');
}
