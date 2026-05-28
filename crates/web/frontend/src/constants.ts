// ============================================================================
// Global constants and configuration
// These are injected by the gateway during template rendering
// ============================================================================

import type { MarketConfig } from './types.js';

// Template-injected values (from gateway).
// These are set from the HTML template before loading main.ts
// Use getters to access them at runtime, not at module load time.

let _loginGatewayUrl = '';
let _currentMarketName = '';
let _defaultSymbol = '';
let _knownMarkets: MarketConfig[] = [];

export function setTemplateConfig(config: {
  loginGatewayUrl?: string;
  currentMarketName?: string;
  defaultSymbol?: string;
  knownMarkets?: MarketConfig[];
}): void {
  if (config.loginGatewayUrl) _loginGatewayUrl = config.loginGatewayUrl;
  if (config.currentMarketName) _currentMarketName = config.currentMarketName;
  if (config.defaultSymbol) _defaultSymbol = config.defaultSymbol;
  if (config.knownMarkets) _knownMarkets = config.knownMarkets;
}

export function getLoginGatewayUrl(): string {
  return _loginGatewayUrl;
}

export function getCurrentMarketName(): string {
  return _currentMarketName;
}

export function getDefaultSymbol(): string {
  return _defaultSymbol;
}

export function getKnownMarkets(): MarketConfig[] {
  return _knownMarkets;
}

// Build and version info
export const FRONTEND_BUILD_TAG = 'vite-ts-2026-05-27';
export const LEVELS = 8;

// Timeouts and delays
export const ORDER_PENDING_TIMEOUT_MS = 30000;
export const UI_RENDER_DELAY_MS = 120;
export const PENDING_VISIBILITY_DELAY_MS = 250;
export const LOG_DEDUPE_WINDOW_MS = 10000;

// WebSocket reconnection settings
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15000;
export const RECONNECT_JITTER_MS = 600;
