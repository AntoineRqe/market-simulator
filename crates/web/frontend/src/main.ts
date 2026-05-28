// ============================================================================
// Main entry point for the multi-market terminal
// ============================================================================

import { setTemplateConfig, FRONTEND_BUILD_TAG } from './constants.js';
import { initializeAuth, requireAuth, getMarketTokens, normalizeMarketTokenUrls } from './auth.js';
import { setCurrentPlayer } from './ui.js';
import { addMarket, getPrimaryMarketName, resolveSplitMarketConfigs } from './market.js';
import { connectAllMarkets } from './websocket.js';
import { normalizeMarketName, log } from './utils.js';

/**
 * Initialize template configuration from HTML injections
 */
function initTemplateConfig(): void {
  // Template variables are injected into window scope by index.html
  const config = (window as any).__APP_CONFIG__ || {};

  setTemplateConfig({
    loginGatewayUrl: config.LOGIN_GATEWAY_URL || '',
    currentMarketName: config.CURRENT_MARKET_NAME || '',
    defaultSymbol: config.DEFAULT_SYMBOL || '',
    knownMarkets: config.KNOWN_MARKETS || [],
  });
}

/**
 * Initialize user session from storage
 */
function initializeUserSession(): void {
  const username = sessionStorage.getItem('auth_username') || null;
  const passwordSuffix = sessionStorage.getItem('auth_password')
    ? sessionStorage.getItem('auth_password')!.slice(-4)
    : '';
  const isAdmin = sessionStorage.getItem('auth_is_admin') === 'true';

  if (username) {
    setCurrentPlayer(username, passwordSuffix, isAdmin);
  }
}

/**
 * Initialize all configured markets
 */
function initializeMarkets(): void {
  const configs = resolveSplitMarketConfigs();
  log('[Boot] Initializing markets:', configs.length);

  configs.forEach((market) => {
    const name = normalizeMarketName(market.name || '');
    if (name) {
      addMarket(name);
      log(`[Boot] Added market: ${name}`);
    }
  });

  // Ensure primary market exists
  const primary = getPrimaryMarketName();
  if (primary && !resolveSplitMarketConfigs().find((m) => normalizeMarketName(m.name) === primary)) {
    addMarket(primary);
    log(`[Boot] Added primary market: ${primary}`);
  }
}

/**
 * Initialize WebSocket connections
 */
async function initializeConnections(): Promise<void> {
  log('[Boot] Initializing WebSocket connections');
  try {
    await connectAllMarkets();
    log('[Boot] WebSocket connections initialized');
  } catch (err) {
    console.error('[Boot] Failed to initialize connections:', err);
  }
}

/**
 * Initialize the application
 */
async function init(): Promise<void> {
  try {
    // Initialize template configuration first
    initTemplateConfig();
    log('[Boot] Frontend:', FRONTEND_BUILD_TAG);

    // Initialize authentication from URL and session storage
    initializeAuth();

    // Normalize market token URLs for HTTPS proxying
    const marketTokens = getMarketTokens();
    normalizeMarketTokenUrls(marketTokens);

    // Verify authentication; redirect to login if not authenticated
    requireAuth();
    log('[Boot] Authentication successful');

    // Initialize user session (username, admin status, etc.)
    initializeUserSession();

    // Initialize all configured markets
    initializeMarkets();

    // Initialize WebSocket connections
    await initializeConnections();

    log('[Boot] Application initialized successfully');
  } catch (err) {
    console.error('[Boot] Initialization failed:', err);
    throw err;
  }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
