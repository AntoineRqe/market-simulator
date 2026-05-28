// ============================================================================
// WebSocket management for primary and secondary markets
// ============================================================================

import { getAuthToken, getUsername, getPassword, getMarketTokens } from './auth.js';
import { getPrimaryMarketName, getOrCreateMarket, setMarketConnected, setMarketWebSocket } from './market.js';
import { getKnownMarkets, RECONNECT_BASE_MS, RECONNECT_MAX_MS, RECONNECT_JITTER_MS } from './constants.js';
import { normalizeMarketName, nextReconnectDelay, now } from './utils.js';
import { handleServerMessage, updateWsIndicator, logServerEvent } from './handlers.js';
import type { MarketConfig } from './types.js';

const WS_DISCONNECT_NOTICE_MS = 5000;
let wsDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let primaryWs: WebSocket | null = null;

// WebSocket reconnection state
let primaryReconnectAttempts = 0;
let primaryReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const marketReconnectAttempts: Record<string, number> = {};
const marketReconnectTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};

/**
 * Build WebSocket endpoint URL from base URL
 */
function buildWsEndpoint(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}${parsed.pathname || ''}/ws`;
  } catch {
    return `ws://${baseUrl}/ws`;
  }
}

/**
 * Build HTTP endpoint URL
 */
function buildEndpoint(baseUrl: string, path: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname || ''}${path}`;
  } catch {
    return `http://${baseUrl}${path}`;
  }
}

/**
 * Get current app base URL (protocol + host)
 */
function getCurrentAppBaseUrl(): string {
  return `${location.protocol}//${location.host}`;
}

/**
 * Enforce secure WebSocket if on HTTPS
 */
function enforceSecureWsIfNeeded(wsUrl: string): string {
  if (location.protocol === 'https:') {
    return wsUrl.replace(/^ws:/, 'wss:');
  }
  return wsUrl;
}

/**
 * Sanitize WebSocket URL (ensure valid format)
 */
function sanitizeWebSocketUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    // If URL parsing fails, return as-is and let WebSocket constructor handle it
    return url;
  }
}

/**
 * Schedule primary WebSocket reconnection with exponential backoff
 */
export function schedulePrimaryReconnect(): number {
  if (primaryReconnectTimer) clearTimeout(primaryReconnectTimer);
  const delay = nextReconnectDelay(
    primaryReconnectAttempts,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    RECONNECT_JITTER_MS
  );
  primaryReconnectAttempts += 1;
  primaryReconnectTimer = setTimeout(() => {
    primaryReconnectTimer = null;
    connectPrimaryWS();
  }, delay);
  return delay;
}

/**
 * Reset primary WebSocket reconnection state
 */
export function resetPrimaryReconnect(): void {
  primaryReconnectAttempts = 0;
  if (primaryReconnectTimer) {
    clearTimeout(primaryReconnectTimer);
    primaryReconnectTimer = null;
  }
}

/**
 * Schedule market-specific WebSocket reconnection
 */
export function scheduleMarketReconnect(
  marketName: string,
  market: MarketConfig
): number {
  if (!marketName) return 0;
  if (marketReconnectTimers[marketName]) {
    clearTimeout(marketReconnectTimers[marketName]);
  }
  const delay = nextReconnectDelay(
    marketReconnectAttempts[marketName] || 0,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    RECONNECT_JITTER_MS
  );
  marketReconnectAttempts[marketName] = (marketReconnectAttempts[marketName] || 0) + 1;
  marketReconnectTimers[marketName] = setTimeout(() => {
    marketReconnectTimers[marketName] = null;
    connectMarketWS(market);
  }, delay);
  return delay;
}

/**
 * Reset market-specific reconnection state
 */
export function resetMarketReconnect(marketName: string): void {
  if (!marketName) return;
  marketReconnectAttempts[marketName] = 0;
  if (marketReconnectTimers[marketName]) {
    clearTimeout(marketReconnectTimers[marketName]);
    marketReconnectTimers[marketName] = null;
  }
}

/**
 * Get authentication token for a market
 */
async function getMarketAuthToken(market: MarketConfig): Promise<string> {
  const normalizedTarget = normalizeMarketName(market.name || '');
  const marketTokens = getMarketTokens();
  const hasMultiMarketAuth = marketTokens && Object.keys(marketTokens).length > 0;

  // If we have multi-market tokens from gateway login, use those
  if (hasMultiMarketAuth && marketTokens && marketTokens[normalizedTarget]) {
    return marketTokens[normalizedTarget].token || '';
  }

  // Fallback to primary market token (single-market auth)
  if (normalizedTarget === getPrimaryMarketName()) {
    return getAuthToken() || '';
  }

  // Try to login to other markets using saved credentials
  const username = getUsername() || '';
  const password = getPassword() || '';

  if (!username || !password) {
    throw new Error('Missing saved credentials for cross-market login');
  }

  const gatewayBase = getCurrentAppBaseUrl();
  const res = await fetch(buildEndpoint(gatewayBase, '/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, market: normalizedTarget }),
  });
  const data = (await res.json()) as any;
  if (!res.ok || !data.token) {
    throw new Error(data.error || 'Authentication failed');
  }
  return data.token;
}

/**
 * Connect to primary market WebSocket
 */
export function connectPrimaryWS(): void {
  const primaryMarketName = getPrimaryMarketName();
  if (!primaryMarketName) {
    console.error('[WebSocket] No primary market configured');
    return;
  }

  // Get token and URL from either single-market or multi-market auth
  let token = '';
  let marketUrl = getCurrentAppBaseUrl();

  const marketTokens = getMarketTokens();
  const hasMultiMarketAuth = marketTokens && Object.keys(marketTokens).length > 0;

  if (hasMultiMarketAuth && marketTokens && marketTokens[primaryMarketName]) {
    token = encodeURIComponent(marketTokens[primaryMarketName].token || '');
    marketUrl = marketTokens[primaryMarketName].url || marketUrl;
  } else {
    const authToken = getAuthToken();
    if (authToken) {
      token = encodeURIComponent(authToken);
    }
  }

  const wsBase = enforceSecureWsIfNeeded(buildWsEndpoint(marketUrl));
  const market = encodeURIComponent(primaryMarketName || '');
  const username = encodeURIComponent(getUsername() || '');
  const wsUrl = sanitizeWebSocketUrl(
    `${wsBase}?token=${token}&market=${market}&username=${username}`
  );

  console.log(`[WebSocket] Connecting to ${primaryMarketName} at ${wsUrl}`);
  primaryWs = new WebSocket(wsUrl);

  primaryWs.onopen = () => {
    resetPrimaryReconnect();
    updateWsIndicator(true);
    if (wsDisconnectTimer) {
      clearTimeout(wsDisconnectTimer);
      wsDisconnectTimer = null;
    }
    logServerEvent({
      ts: now(),
      label: 'INFO',
      body: 'WebSocket connected',
      tag: 'info',
    });

    // Update primary market connection state
    const market = getOrCreateMarket(primaryMarketName);
    market.ws = primaryWs;
    setMarketConnected(primaryMarketName, true);
    setMarketWebSocket(primaryMarketName, primaryWs);
  };

  primaryWs.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data) as any;
      handleServerMessage(msg, primaryMarketName);
    } catch (err) {
      console.error('[WebSocket] Message parse error:', err);
    }
  };

  primaryWs.onclose = () => {
    updateWsIndicator(false);
    primaryWs = null;

    setMarketConnected(primaryMarketName, false);
    setMarketWebSocket(primaryMarketName, null);

    wsDisconnectTimer = setTimeout(() => {
      const delay = schedulePrimaryReconnect();
      logServerEvent({
        ts: now(),
        label: 'INFO',
        body: `WebSocket disconnected — reconnecting in ${Math.round(delay / 1000)}s…`,
        tag: 'info',
      });
    }, WS_DISCONNECT_NOTICE_MS);
  };

  primaryWs.onerror = (err: Event) => {
    console.error('[WebSocket] Error:', err);
  };
}

/**
 * Connect to secondary market WebSocket
 */
export async function connectMarketWS(market: MarketConfig): Promise<void> {
  if (!market || !market.name || !market.url) {
    console.error('[Market] Invalid market config', market);
    return;
  }

  const marketName = normalizeMarketName(market.name);
  const marketObj = getOrCreateMarket(marketName);

  // Don't reconnect if already connected
  if (
    marketObj.ws &&
    marketObj.ws.readyState !== WebSocket.CLOSED &&
    marketObj.ws.readyState !== WebSocket.CLOSING
  ) {
    return;
  }

  // Skip if this is the primary market (handled separately)
  if (marketName === getPrimaryMarketName()) {
    return;
  }

  try {
    const token = encodeURIComponent(await getMarketAuthToken(market));
    const wsBase = enforceSecureWsIfNeeded(buildWsEndpoint(market.url));
    const username = encodeURIComponent(getUsername() || '');
    const wsUrl = sanitizeWebSocketUrl(
      `${wsBase}?token=${token}&market=${encodeURIComponent(marketName)}&username=${username}`
    );

    console.log(`[Market] Connecting to ${market.name} at ${wsUrl}`);

    const marketWs = new WebSocket(wsUrl);

    marketWs.onopen = () => {
      resetMarketReconnect(marketName);
      console.log(`[Market] ${marketName} WebSocket connected`);
      marketObj.ws = marketWs;
      setMarketConnected(marketName, true);
      setMarketWebSocket(marketName, marketWs);
      logServerEvent({
        ts: now(),
        label: 'INFO',
        body: `Market "${marketName}" connected`,
        tag: 'info',
      });
    };

    marketWs.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data) as any;
        handleServerMessage(msg, marketName);
      } catch (err) {
        console.error(`[Market] ${marketName} message parse error:`, err);
      }
    };

    marketWs.onclose = () => {
      console.log(`[Market] ${marketName} WebSocket closed`);
      marketObj.ws = null;
      setMarketConnected(marketName, false);
      setMarketWebSocket(marketName, null);

      const delay = scheduleMarketReconnect(marketName, market);
      logServerEvent({
        ts: now(),
        label: 'INFO',
        body: `Market "${marketName}" disconnected — reconnecting in ${Math.round(delay / 1000)}s…`,
        tag: 'info',
      });
    };

    marketWs.onerror = (err: Event) => {
      console.error(`[Market] ${marketName} error:`, err);
    };
  } catch (err) {
    console.error(`[Market] ${marketName} connection failed:`, err);
    const delay = scheduleMarketReconnect(marketName, market);
    logServerEvent({
      ts: now(),
      label: 'ERROR',
      body: `Market "${marketName}" auth failed — retrying in ${Math.round(delay / 1000)}s…`,
      tag: 'error',
    });
  }
}

/**
 * Connect to all configured markets
 */
export async function connectAllMarkets(): Promise<void> {
  const markets = getKnownMarkets();
  if (!Array.isArray(markets)) return;

  // Connect primary market first
  const primary = getPrimaryMarketName();
  if (primary) {
    connectPrimaryWS();
  }

  // Connect secondary markets
  for (const market of markets) {
    if (market && market.name && normalizeMarketName(market.name) !== primary) {
      try {
        await connectMarketWS(market);
      } catch (err) {
        console.error(`[Market] Failed to connect to ${market.name}:`, err);
      }
    }
  }
}

/**
 * Disconnect all WebSockets
 */
export function disconnectAllMarkets(): void {
  if (primaryWs) {
    primaryWs.close();
    primaryWs = null;
  }

  resetPrimaryReconnect();

  const markets = Object.values(getOrCreateMarket('')) as any[];
  for (const market of markets) {
    if (market && market.ws) {
      market.ws.close();
      market.ws = null;
    }
    resetMarketReconnect(market.name);
  }
}

// ============================================================================
// Event handlers (to be connected to business logic)
// ============================================================================

/**
 * Handle incoming server message (FIX, Market Data, Player State, etc.)
 * TODO: Connect to actual message processors
 */
function handleServerMessage(msg: any, marketName: string): void {
  console.log(`[${marketName}] Message:`, msg);
  // TODO: Route to appropriate handler based on message type
  // - FIX execution reports
  // - Market data updates
  // - Player state updates
}

/**
 * Log a server event
 * TODO: Connect to UI log display
 */
function logServerEvent(event: any): void {
  console.log(`[Log] ${event.label}: ${event.body}`);
  // TODO: Append to log panel
}

/**
 * Update WebSocket indicator in UI
 * TODO: Connect to UI indicator
 */
function updateWsIndicator(connected: boolean): void {
  console.log(`[WS Indicator] ${connected ? 'Connected' : 'Disconnected'}`);
  // TODO: Update status dot in UI
}
