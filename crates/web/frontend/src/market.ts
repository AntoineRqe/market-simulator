// ============================================================================
// Market state management
// ============================================================================

import { getKnownMarkets, getDefaultSymbol } from './constants.js';
import { normalizeMarketName } from './utils.js';
import type { MarketBook } from './types.js';

/**
 * Global markets state: marketName → market state with books, orders, chart data
 */
export const markets: Record<string, any> = {};

/**
 * Create initial market book state for a symbol
 */
function createMarketBook(): MarketBook {
  return {
    symbol: '—',
    bid: [],
    ask: [],
  };
}

/**
 * Get configured symbols for a market from config
 */
export function getConfiguredSymbolsForMarket(marketName: string): string[] {
  const normalized = normalizeMarketName(marketName);
  const knownMarkets = getKnownMarkets();
  const market = (Array.isArray(knownMarkets) ? knownMarkets : []).find(
    (candidate) =>
      normalizeMarketName((candidate && candidate.name) || '') === normalized
  );
  const fallback = normalizeMarketName(getDefaultSymbol());
  const symbols = (market && Array.isArray(market.stocks)) ? market.stocks : [];

  const unique = (symbols as string[])
    .map((symbol) => normalizeMarketName(symbol))
    .filter((symbol, idx, arr) => symbol && arr.indexOf(symbol) === idx);

  if (unique.length > 0) return unique;
  return fallback ? [fallback] : [];
}

/**
 * Ensure market has book for a symbol; create if missing
 */
export function ensureMarketBook(
  marketName: string,
  symbol: string
): MarketBook | null {
  const market = markets[normalizeMarketName(marketName)];
  if (!market) return null;

  const normalizedSymbol = normalizeMarketName(symbol);
  if (!normalizedSymbol) return null;

  if (!market.books) market.books = {};
  if (!market.books[normalizedSymbol]) {
    market.books[normalizedSymbol] = createMarketBook();
  }
  market.books[normalizedSymbol].symbol = normalizedSymbol;
  return market.books[normalizedSymbol];
}

/**
 * Get active symbol for a market (with fallback to configured symbols)
 */
export function getActiveMarketSymbol(marketName: string): string {
  const market = markets[normalizeMarketName(marketName)];
  if (!market) return normalizeMarketName(getDefaultSymbol());
  if (market.activeSymbol) return market.activeSymbol;

  const configured = getConfiguredSymbolsForMarket(marketName);
  const fallback =
    configured[0] || normalizeMarketName(getDefaultSymbol());
  market.activeSymbol = fallback;
  return fallback;
}

/**
 * Set active symbol for a market and update UI
 */
export function setActiveMarketSymbol(
  marketName: string,
  symbol: string
): MarketBook | null {
  const mn = normalizeMarketName(marketName);
  const market = markets[mn];
  if (!market) return null;

  const nextSymbol =
    normalizeMarketName(symbol) ||
    getConfiguredSymbolsForMarket(mn)[0] ||
    normalizeMarketName(getDefaultSymbol());

  const bookState = ensureMarketBook(mn, nextSymbol);
  market.activeSymbol = nextSymbol;
  market.book = bookState || createMarketBook();
  market.trades = (market.tradesBySymbol && market.tradesBySymbol[nextSymbol]) || [];
  market.chartPoints =
    (market.chartPointsBySymbol && market.chartPointsBySymbol[nextSymbol]) || [];

  return market.book;
}

/**
 * Get market book for a specific symbol
 */
export function getMarketBookForSymbol(
  marketName: string,
  symbol: string
): MarketBook | null {
  const market = markets[normalizeMarketName(marketName)];
  if (!market) return null;

  const normalizedSymbol =
    normalizeMarketName(symbol) || getActiveMarketSymbol(marketName);
  return ensureMarketBook(normalizeMarketName(marketName), normalizedSymbol);
}

/**
 * Add a new market to global state
 */
export function addMarket(marketName: string): any {
  const normalizedName = normalizeMarketName(marketName);
  if (markets[normalizedName]) return markets[normalizedName];

  const initialSymbol =
    getConfiguredSymbolsForMarket(marketName)[0] ||
    normalizeMarketName(getDefaultSymbol());
  const initialBook = createMarketBook();
  initialBook.symbol = initialSymbol;

  markets[normalizedName] = {
    name: normalizedName,
    ws: null,
    books: { [initialSymbol]: initialBook },
    book: initialBook,
    activeSymbol: initialSymbol,
    tradesBySymbol: {},
    chartPointsBySymbol: {},
    trades: [],
    chartPoints: [],
    openOrders: {},
    openOrderFirstSeen: {},
    orderTimeouts: {},
    chartPts: [],
    lastTradeCount: 0,
    connected: false,
    messageBuffer: [],
  };

  return markets[normalizedName];
}

/**
 * Get the currently selected market for order placement
 */
export function getSelectedOrderMarketName(): string {
  const sel = document.getElementById('o-market') as HTMLSelectElement;
  if (sel && sel.value) {
    return normalizeMarketName(sel.value);
  }
  return getPrimaryMarketName();
}

/**
 * Get or create a market
 */
export function getOrCreateMarket(marketName: string): any {
  const normalized = normalizeMarketName(marketName);
  return markets[normalized] || addMarket(normalized);
}

/**
 * Resolve multiple market configs (handles split view)
 */
export function resolveSplitMarketConfigs(): any[] {
  const knownMarkets = getKnownMarkets();
  if (!Array.isArray(knownMarkets)) return [];

  // For now, return all known markets
  // Later: filter based on authentication, split view preference, etc.
  return knownMarkets.filter((m) => m && m.name);
}

/**
 * Get the primary market name
 */
export function getPrimaryMarketName(): string {
  const configs = resolveSplitMarketConfigs();
  if (configs.length === 0) return '';
  return normalizeMarketName(configs[0].name);
}

/**
 * Check if market is connected
 */
export function isMarketConnected(marketName: string): boolean {
  const market = markets[normalizeMarketName(marketName)];
  return market && market.connected ? true : false;
}

/**
 * Set market connection status
 */
export function setMarketConnected(marketName: string, connected: boolean): void {
  const market = markets[normalizeMarketName(marketName)];
  if (market) {
    market.connected = connected;
  }
}

/**
 * Update market WebSocket reference
 */
export function setMarketWebSocket(marketName: string, ws: WebSocket | null): void {
  const market = markets[normalizeMarketName(marketName)];
  if (market) {
    market.ws = ws;
  }
}

/**
 * Get all markets
 */
export function getAllMarkets(): any[] {
  return Object.values(markets);
}

/**
 * Clear all market data
 */
export function clearMarkets(): void {
  Object.keys(markets).forEach((key) => {
    const market = markets[key];
    if (market && market.ws) {
      market.ws.close();
    }
    delete markets[key];
  });
}
