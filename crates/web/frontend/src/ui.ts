// ============================================================================
// UI state and rendering
// ============================================================================

import { ge, normalizeMarketName, esc, fmt2, fmtNum } from './utils.js';
import { getActiveMarketSymbol, setActiveMarketSymbol, getConfiguredSymbolsForMarket, getSelectedOrderMarketName, resolveSplitMarketConfigs, getOrCreateMarket, getPrimaryMarketName } from './market.js';
import { drawChart } from './chart.js';
import type { UIState, Order, Holdings, OrderOwners } from './types.js';

// Global UI state
export const uiState: UIState = {
  side: 'BUY',
  activeLogTab: 'system',
  mobileActiveMarket: '',
  currentPlayerSuffix: '',
  currentPlayer: null,
  currentIsAdmin: false,
  currentVisitorCount: 0,
  currentTotalVisitorCount: 0,
  lastTokenBalance: null,
};

// Order and portfolio tracking
export const currentHoldings: Holdings = {};
export const orderOwners: OrderOwners = {};
export const orderOwnersByOrderId: Record<string, string> = {};
export const orderIdToBookLocation: Record<string, any> = {};

// Open orders and terminal status tracking
export const openOrders: Record<string, Order> = {};
export const openOrderFirstSeen: Record<string, number> = {};
export const orderTerminalStatus: Record<string, string> = {};

// Rendering debounce timers
let orderBookRenderTimer: ReturnType<typeof setTimeout> | null = null;
let openOrdersRenderTimer: ReturnType<typeof setTimeout> | null = null;

const UI_RENDER_DELAY_MS = 120;
const PENDING_VISIBILITY_DELAY_MS = 100;
const LOG_DEDUPE_WINDOW_MS = 2000;
const MAX_LOG_ENTRIES = 300;

// Log tracking for deduplication
const logEntries: Array<{ ts: string; label: string; body: string; tag: string }> = [];
const recentLogTimestamps: Record<string, number> = {};

/**
 * Set UI trading side (BUY or SELL)
 */
export function setTradingSide(side: 'BUY' | 'SELL'): void {
  uiState.side = side;
  updateSideDisplay();
}

/**
 * Get current trading side
 */
export function getTradingSide(): 'BUY' | 'SELL' {
  return uiState.side;
}

/**
 * Update trading side display in UI
 */
function updateSideDisplay(): void {
  const btn = ge('toggle-side');
  if (btn) {
    btn.textContent = uiState.side;
    btn.setAttribute('aria-label', `Current side: ${uiState.side}`);
  }
}

/**
 * Set active log tab
 */
export function setActiveLogTab(tab: string): void {
  uiState.activeLogTab = tab;
  renderLogTabs();
  renderLog();
}

/**
 * Get active log tab
 */
export function getActiveLogTab(): string {
  return uiState.activeLogTab;
}

/**
 * Set current player info
 */
export function setCurrentPlayer(
  username: string | null,
  suffix: string = '',
  isAdmin: boolean = false
): void {
  uiState.currentPlayer = username;
  uiState.currentPlayerSuffix = suffix;
  uiState.currentIsAdmin = isAdmin;
  updatePlayerDisplay();
}

/**
 * Get current player
 */
export function getCurrentPlayer(): string | null {
  return uiState.currentPlayer;
}

/**
 * Get current player suffix (for ClOrdID)
 */
export function getCurrentPlayerSuffix(): string {
  return uiState.currentPlayerSuffix;
}

/**
 * Check if current user is admin
 */
export function isCurrentUserAdmin(): boolean {
  return uiState.currentIsAdmin;
}

/**
 * Update player display in topbar
 */
function updatePlayerDisplay(): void {
  const playerSpan = ge('player-name');
  if (playerSpan) {
    const suffix = uiState.currentPlayerSuffix
      ? ` (${uiState.currentPlayerSuffix})`
      : '';
    playerSpan.textContent = `${uiState.currentPlayer || 'Guest'}${suffix}`;
  }
}

/**
 * Set visitor count
 */
export function setVisitorCount(count: number, total: number): void {
  uiState.currentVisitorCount = count;
  uiState.currentTotalVisitorCount = total;
  updateVisitorDisplay();
}

/**
 * Update visitor count display
 */
function updateVisitorDisplay(): void {
  const visitorSpan = ge('visitor-count');
  if (visitorSpan) {
    visitorSpan.textContent = `${uiState.currentVisitorCount}/${uiState.currentTotalVisitorCount} visitors`;
  }
}

/**
 * Set token balance
 */
export function setTokenBalance(balance: number | null): void {
  if (balance !== null && balance !== uiState.lastTokenBalance) {
    uiState.lastTokenBalance = balance;
    updateTokenDisplay();
  }
}

/**
 * Update token balance display
 */
function updateTokenDisplay(): void {
  const tokenSpan = ge('token-balance');
  if (tokenSpan && uiState.lastTokenBalance !== null) {
    tokenSpan.textContent = `$${uiState.lastTokenBalance.toFixed(2)}`;
  }
}

/**
 * Render market tabs for multi-market support
 */
export function renderMarketTabs(): void {
  const host = ge('market-tabs');
  if (!host) return;

  const options = resolveSplitMarketConfigs()
    .map((m) => normalizeMarketName(m.name || ''))
    .filter(Boolean);

  if (options.length === 0) {
    host.innerHTML = '';
    return;
  }

  const selected = getSelectedOrderMarketName();
  host.innerHTML = options
    .map((name) => {
      const active = normalizeMarketName(name) === normalizeMarketName(selected);
      return `<button type="button" class="symbol-tab ${
        active ? 'active' : ''
      }" data-market="${esc(name)}">${esc(name)}</button>`;
    })
    .join('');

  host.querySelectorAll('button[data-market]').forEach((btn) => {
    const marketBtn = btn as HTMLButtonElement;
    marketBtn.onclick = () => selectOrderMarket(marketBtn.dataset.market || '');
  });
}

/**
 * Select which market to place orders on
 */
export function selectOrderMarket(marketName: string): void {
  const sel = ge('o-market') as HTMLSelectElement;
  if (!sel) return;

  const nextMarket = normalizeMarketName(marketName);
  if (!nextMarket) return;

  sel.value = nextMarket;
  renderMarketTabs();
  renderSymbolTabs();
  renderLog();
}

/**
 * Render symbol tabs for the selected market
 */
export function renderSymbolTabs(): void {
  const host = ge('symbol-tabs');
  if (!host) return;

  const marketName = getSelectedOrderMarketName();
  const symbols = getConfiguredSymbolsForMarket(marketName);
  const activeSymbol = getActiveMarketSymbol(marketName);

  if (symbols.length === 0) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = symbols
    .map((symbol) => {
      const active = normalizeMarketName(symbol) === normalizeMarketName(activeSymbol);
      return `<button type="button" class="symbol-tab ${
        active ? 'active' : ''
      }" data-symbol="${esc(symbol)}">${esc(symbol)}</button>`;
    })
    .join('');

  host.querySelectorAll('button[data-symbol]').forEach((btn) => {
    const symBtn = btn as HTMLButtonElement;
    symBtn.onclick = () =>
      selectMarketSymbol(marketName, symBtn.dataset.symbol || '');
  });
}

/**
 * Select a symbol for trading
 */
export function selectMarketSymbol(marketName: string, symbol: string): void {
  const mn = normalizeMarketName(marketName);
  const nextSymbol = normalizeMarketName(symbol);
  if (!mn || !nextSymbol) return;

  setActiveMarketSymbol(mn, nextSymbol);
  renderSymbolTabs();
  renderLog();

  // Update order entry form
  const sel = ge('o-sym') as HTMLSelectElement;
  if (sel && sel.value !== nextSymbol) {
    sel.value = nextSymbol;
  }
}

/**
 * Render order book for current market/symbol
 * Debounced to batch updates
 */
export function renderOrderBook(immediate: boolean = false): void {
  if (orderBookRenderTimer) {
    clearTimeout(orderBookRenderTimer);
  }

  if (immediate) {
    performOrderBookRender();
  } else {
    orderBookRenderTimer = setTimeout(performOrderBookRender, UI_RENDER_DELAY_MS);
  }
}

/**
 * Perform actual order book rendering
 */
function performOrderBookRender(): void {
  orderBookRenderTimer = null;

  const bookContainer = ge('order-book-container');
  if (!bookContainer) return;

  const bidsContainer = ge('bids-list');
  const asksContainer = ge('asks-list');
  if (!bidsContainer || !asksContainer) return;

  // Get current market and book
  const primaryMarket = getPrimaryMarketName();
  const market = getOrCreateMarket(primaryMarket);
  if (!market || !market.book) {
    bidsContainer.innerHTML = '<span style="color:var(--muted);font-size:10px">No data</span>';
    asksContainer.innerHTML = '<span style="color:var(--muted);font-size:10px">No data</span>';
    return;
  }

  const book = market.book;

  // Render bids (green, highest prices first)
  if (book.bid && book.bid.length > 0) {
    bidsContainer.innerHTML = book.bid
      .slice(0, 10) // Show top 10 levels
      .map(level => {
        const pct = level.quantity > 0 ? Math.min(100, (level.quantity / 1000) * 100) : 0;
        return `<div class="book-level bid" style="--pct:${pct}%">
          <span class="qty">${fmtNum(level.quantity)}</span>
          <span class="price">${fmt2(level.price)}</span>
        </div>`;
      })
      .join('');
  } else {
    bidsContainer.innerHTML = '<span style="color:var(--muted);font-size:10px">No bids</span>';
  }

  // Render asks (red, lowest prices first)
  if (book.ask && book.ask.length > 0) {
    asksContainer.innerHTML = book.ask
      .slice(0, 10) // Show top 10 levels
      .map(level => {
        const pct = level.quantity > 0 ? Math.min(100, (level.quantity / 1000) * 100) : 0;
        return `<div class="book-level ask" style="--pct:${pct}%">
          <span class="qty">${fmtNum(level.quantity)}</span>
          <span class="price">${fmt2(level.price)}</span>
        </div>`;
      })
      .join('');
  } else {
    asksContainer.innerHTML = '<span style="color:var(--muted);font-size:10px">No asks</span>';
  }
}

/**
 * Render open orders for current market/symbol
 * Debounced to batch updates
 */
export function renderOrders(
  orders: Order[] | null = null,
  immediate: boolean = false
): void {
  if (openOrdersRenderTimer) {
    clearTimeout(openOrdersRenderTimer);
  }

  if (immediate) {
    performOrdersRender(orders);
  } else {
    openOrdersRenderTimer = setTimeout(
      () => performOrdersRender(orders),
      UI_RENDER_DELAY_MS
    );
  }
}

/**
 * Perform actual orders rendering
 */
function performOrdersRender(_orders: Order[] | null = null): void {
  openOrdersRenderTimer = null;

  const list = ge('orders-list');
  if (!list) return;

  const orderIds = Object.keys(openOrders);

  if (orderIds.length === 0) {
    list.innerHTML = '<span style="color:var(--muted);font-size:10px">No open orders</span>';
    renderHoldings();
    return;
  }

  list.innerHTML = orderIds
    .map(clordId => {
      const order = openOrders[clordId];
      const isSell = order.side === 'SELL';
      const sideClass = isSell ? 'sell' : 'buy';

      return `<div class="order-row ${sideClass}">
        <div class="order-info">
          <span class="side">${isSell ? 'SELL' : 'BUY'}</span>
          <span class="sym">${esc(order.symbol)}</span>
          <span class="qty">${fmtNum(order.quantity)}</span>
          <span class="px">@ ${fmt2(order.price)}</span>
        </div>
        <div class="order-status">${order.status}</div>
      </div>`;
    })
    .join('');

  renderHoldings();
}

/**
 * Render log entries to log panel
 */
function renderLog(): void {
  const logBox = ge('log-box');
  if (!logBox) return;

  logBox.innerHTML = logEntries
    .slice(-50) // Show last 50 entries
    .map(entry => {
      const tagClass = `t${entry.tag}`;
      return `<div class="le">
        <span class="lts">[${esc(entry.ts)}]</span>
        <span class="llbl ${tagClass}">${esc(entry.label)}</span>
        <div class="lbody">${esc(entry.body)}</div>
      </div>`;
    })
    .join('');

  logBox.scrollTop = logBox.scrollHeight;
}

/**
 * Render log tabs (system, FIX, MD)
 */
function renderLogTabs(): void {
  const systemTab = ge('log-tab-system');
  const fixTab = ge('log-tab-fix');
  const mdTab = ge('log-tab-md');

  if (!systemTab || !fixTab || !mdTab) return;

  const activeTab = uiState.activeLogTab || 'system';
  [
    { el: systemTab, name: 'system' },
    { el: fixTab, name: 'fix' },
    { el: mdTab, name: 'md' },
  ].forEach(({ el, name }) => {
    el.classList.toggle('active', name === activeTab);
  });

  // Show/hide log panels
  const systemPanel = ge('log-panel-system');
  const fixPanel = ge('log-panel-fix');
  const mdPanel = ge('log-panel-md');

  if (systemPanel) systemPanel.style.display = activeTab === 'system' ? 'block' : 'none';
  if (fixPanel) fixPanel.style.display = activeTab === 'fix' ? 'block' : 'none';
  if (mdPanel) mdPanel.style.display = activeTab === 'md' ? 'block' : 'none';
}

/**
 * Append log entry
 */
export function appendLog(entry: { ts: string; label: string; body: string; tag: string }): void {
  // Deduplicate recent entries
  const now = Date.now();
  const key = `${entry.tag}|${entry.label}|${entry.body}`;
  const lastTs = recentLogTimestamps[key] || 0;

  if (now - lastTs < LOG_DEDUPE_WINDOW_MS) {
    return;
  }

  recentLogTimestamps[key] = now;

  // Clean up old dedupe entries
  Object.keys(recentLogTimestamps).forEach(k => {
    if (now - recentLogTimestamps[k] > LOG_DEDUPE_WINDOW_MS) {
      delete recentLogTimestamps[k];
    }
  });

  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }

  renderLog();
}

/**
 * Merge client orders with order book
 * Used for reconciliation after connection
 */
export function mergeClientOpenOrdersFromBook(
  marketName: string,
  symbol: string
): void {
  const mn = normalizeMarketName(marketName);
  const sym = normalizeMarketName(symbol);
  console.log(`[UI] Merging orders from book: ${mn}/${sym}`);
  // TODO: Implement order reconciliation
}

/**
 * Render holdings (portfolio positions)
 */
export function renderHoldings(): void {
  const list = ge('holdings-list');
  if (!list) return;

  const entries = Object.entries(currentHoldings)
    .filter(([, holding]) => Number(holding?.quantity || 0) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (entries.length === 0) {
    list.innerHTML = '<span style="color:var(--muted);font-size:10px">No holdings</span>';
    return;
  }

  list.innerHTML = `<div class="holdings-panel">${entries
    .map(([symbol, holding]) => {
      const qty = Number(holding?.quantity || 0);
      const avgPrice = Number(holding?.avgPrice || 0);
      return `<div class="holding-card">
        <div class="holding-top">
          <span class="holding-symbol">${esc(symbol)}</span>
        </div>
        <div class="holding-meta">
          <div>
            AVG BUY
            <strong>${avgPrice > 0 ? fmt2(avgPrice) : '—'}</strong>
          </div>
          <div>
            POSITION
            <strong>${fmtNum(qty)}</strong>
          </div>
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

/**
 * Render trades panel
 */
export function renderTradesPanel(): void {
  const list = ge('trades-list');
  if (!list) return;

  const primaryMarket = getPrimaryMarketName();
  const market = getOrCreateMarket(primaryMarket);

  if (!market || !market.trades || market.trades.length === 0) {
    list.innerHTML = '<span style="color:var(--muted);font-size:10px">No trades</span>';
    return;
  }

  list.innerHTML = market.trades
    .slice(-20) // Show last 20 trades
    .reverse() // Most recent first
    .map(trade => {
      return `<div class="trade-row">
        <span class="trade-price">${fmt2(trade.price)}</span>
        <span class="trade-qty">${fmtNum(trade.quantity)}</span>
        <span class="trade-time">${new Date(trade.timestamp).toLocaleTimeString()}</span>
      </div>`;
    })
    .join('');

  // Render chart with trade points
  if (market.chartPoints && market.chartPoints.length > 0) {
    drawChart(market.chartPoints);
  }
}

/**
 * Render order cost preview (buying power display)
 */
export function renderOrderCostPreview(): void {
  const el = ge('order-cost-preview');
  if (!el) return;

  const qty = Number((ge('o-qty') as HTMLInputElement)?.value || 0);
  const price = Number((ge('o-price') as HTMLInputElement)?.value || 0);
  const cost = qty * price;

  if (cost > 0) {
    const balance = uiState.lastTokenBalance || 0;
    const canAfford = balance >= cost;
    const statusText = canAfford ? '✓ OK' : '✗ INSUFFICIENT';
    el.textContent = `Cost: ${fmtNum(cost)} | ${statusText}`;
    el.style.color = canAfford ? 'var(--green)' : 'var(--red)';
  } else {
    el.textContent = '—';
    el.style.color = 'var(--muted)';
  }
}

/**
 * Clear UI state for logout
 */
export function clearUIState(): void {
  uiState.currentPlayer = null;
  uiState.currentPlayerSuffix = '';
  uiState.currentIsAdmin = false;
  uiState.lastTokenBalance = null;
  Object.keys(currentHoldings).forEach((key) => delete currentHoldings[key]);
  Object.keys(orderOwners).forEach((key) => delete orderOwners[key]);
  Object.keys(orderOwnersByOrderId).forEach((key) => delete orderOwnersByOrderId[key]);
  updatePlayerDisplay();
  updateTokenDisplay();
}

/**
 * Update player state from server
 */
export function updatePlayerState(playerData: {
  username: string | null;
  is_admin: boolean;
  token_balance: number;
  visitor_count: number;
  total_visitors: number;
}): void {
  setCurrentPlayer(playerData.username, uiState.currentPlayerSuffix, playerData.is_admin);
  setTokenBalance(playerData.token_balance);
  setVisitorCount(playerData.visitor_count, playerData.total_visitors);
}

/**
 * Update token balance
 */
export function updateTokenBalance(tokens: number): void {
  setTokenBalance(tokens);
}

/**
 * Get current holdings
 */
export function getCurrentHoldings(): any {
  return {
    tokens: uiState.lastTokenBalance || 0,
    positions: { ...currentHoldings },
  };
}

/**
 * Get order owners
 */
export function getOrderOwners(): OrderOwners {
  return orderOwners;
}

/**
 * Get open orders
 */
export function getOpenOrders(): Record<string, Order> {
  return openOrders;
}

/**
 * Set an open order
 */
export function setOpenOrder(clordId: string, order: Order): void {
  openOrders[clordId] = order;
  if (!openOrderFirstSeen[clordId]) {
    openOrderFirstSeen[clordId] = Date.now();
  }
}

/**
 * Delete an open order
 */
export function deleteOpenOrder(clordId: string): void {
  delete openOrders[clordId];
  delete openOrderFirstSeen[clordId];
}

/**
 * Get terminal status for order
 */
export function getTerminalStatusForOrder(clordId: string): string | undefined {
  return orderTerminalStatus[clordId];
}

/**
 * Set terminal status for order
 */
export function setTerminalStatusForOrder(clordId: string, status: string): void {
  orderTerminalStatus[clordId] = status;
}

/**
 * Get trading symbol state
 */
export function getTradingSymbolState(): any {
  // Returns current trading parameters
  return {
    side: uiState.side,
  };
}
