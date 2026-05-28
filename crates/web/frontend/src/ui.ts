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
  updateAdminControls();
}

function updateAdminControls(): void {
  const row = ge('admin-footer-row');
  const isAdmin = uiState.currentIsAdmin;
  if (row) {
    row.style.display = isAdmin ? 'flex' : 'none';
  }

  const disable = !isAdmin;
  const clearBook = ge('btn-clear-book') as HTMLButtonElement | null;
  const resetSeq = ge('btn-reset-seq') as HTMLButtonElement | null;
  const resetTokens = ge('btn-reset-tokens') as HTMLButtonElement | null;
  if (clearBook) clearBook.disabled = disable;
  if (resetSeq) resetSeq.disabled = disable;
  if (resetTokens) resetTokens.disabled = disable;
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

  const marketSelect = ge('o-market') as HTMLSelectElement | null;
  if (marketSelect) {
    marketSelect.innerHTML = options
      .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
      .join('');
    marketSelect.value = options.includes(selected) ? selected : options[0];
  }

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
  renderSplitMarketCards();
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

  const symbolSelect = ge('o-sym') as HTMLSelectElement | null;
  if (symbolSelect) {
    symbolSelect.innerHTML = symbols
      .map((symbol) => `<option value="${esc(symbol)}">${esc(symbol)}</option>`)
      .join('');
    symbolSelect.value = symbols.includes(activeSymbol) ? activeSymbol : symbols[0];
  }

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

  const marketNames = resolveSplitMarketConfigs()
    .map((m) => normalizeMarketName(m.name || ''))
    .filter(Boolean);

  // Keep symbol selection globally synchronized across all visible markets.
  marketNames.forEach((name) => {
    const symbols = getConfiguredSymbolsForMarket(name);
    if (symbols.includes(nextSymbol)) {
      setActiveMarketSymbol(name, nextSymbol);
    }
  });

  // Ensure the target market is updated even if config list is empty.
  setActiveMarketSymbol(mn, nextSymbol);
  renderSymbolTabs();
  renderTradesPanel();
  renderSplitMarketCards();
  renderLog();

  // Update order entry form
  const sel = ge('o-sym') as HTMLSelectElement;
  if (sel && sel.value !== nextSymbol) {
    sel.value = nextSymbol;
  }
  applyDefaultLimitPriceFromBook(true);
}

function renderMarketBookLevels(levels: Array<{ price: number; quantity: number }>, sideClass: 'bid-lv' | 'ask-lv'): string {
  if (!Array.isArray(levels) || levels.length === 0) {
    return `<span style="color:var(--muted);font-size:10px;padding:4px 8px;display:block">${sideClass === 'bid-lv' ? 'No bids' : 'No asks'}</span>`;
  }

  return levels
    .slice(0, 8)
    .map((level) => {
      const qty = Number(level.quantity || 0);
      const pct = qty > 0 ? Math.min(100, (qty / 1000) * 100) : 0;
      return `<div class="bk-level ${sideClass}">
        <div class="bar" style="width:${pct}%"></div>
        <span class="lv-maker">MKT</span>
        <span class="lv-qty"><span class="lv-qty-num">${fmtNum(qty)}</span></span>
        <span class="lv-px">${fmt2(Number(level.price || 0))}</span>
      </div>`;
    })
    .join('');
}

function renderMarketChartSvg(points: Array<{ price: number }>): string {
  if (!Array.isArray(points) || points.length < 2) {
    return `<svg viewBox="0 0 400 72" preserveAspectRatio="none"><line x1="0" y1="36" x2="400" y2="36" stroke="var(--border)" stroke-width="1" /></svg>`;
  }

  const recent = points.slice(-40);
  const prices = recent.map((p) => Number(p.price || 0)).filter((p) => Number.isFinite(p));
  if (prices.length < 2) {
    return `<svg viewBox="0 0 400 72" preserveAspectRatio="none"><line x1="0" y1="36" x2="400" y2="36" stroke="var(--border)" stroke-width="1" /></svg>`;
  }

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const span = Math.max(0.0001, maxP - minP);

  const path = prices
    .map((price, idx) => {
      const x = (idx / Math.max(1, prices.length - 1)) * 400;
      const y = 66 - ((price - minP) / span) * 58;
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return `<svg viewBox="0 0 400 72" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="var(--green)" stroke-width="2" />
    <line x1="0" y1="66" x2="400" y2="66" stroke="var(--border)" stroke-width="1" />
  </svg>`;
}

export function renderSplitMarketCards(): void {
  const container = ge('markets-container');
  if (!container) return;

  const marketNames = resolveSplitMarketConfigs()
    .map((m) => normalizeMarketName(m.name || ''))
    .filter(Boolean);

  if (marketNames.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.style.display = 'grid';
  const colBook = ge('col-book');
  if (colBook) colBook.style.display = 'none';

  container.innerHTML = marketNames
    .map((marketName) => {
      const market = getOrCreateMarket(marketName);
      const activeSymbol = getActiveMarketSymbol(marketName);
      const book = (market.books && market.books[activeSymbol]) || market.book;
      const bids = (book && Array.isArray(book.bid)) ? book.bid : [];
      const asks = (book && Array.isArray(book.ask)) ? book.ask : [];
      const trades = Array.isArray(market.trades) ? market.trades.slice(-5).reverse() : [];
      const chartPoints = Array.isArray(market.chartPoints) ? market.chartPoints : [];
      const symbols = getConfiguredSymbolsForMarket(marketName);
      const lastTrade = trades.length > 0 ? trades[0] : null;

      return `<div class="market-card" data-market="${esc(marketName)}">
        <div class="market-card-header">
          <h3>${esc(marketName)}</h3>
          <span class="market-subtitle">${esc(activeSymbol)} • last: ${lastTrade ? fmt2(Number(lastTrade.price || 0)) : '—'}</span>
        </div>
        <div class="market-book">
          <div class="market-book-layout">
            <div class="market-book-section">
              <div class="market-symbol-tabs">
                ${symbols
                  .map((symbol) => `<button type="button" class="symbol-tab market-symbol-tab ${normalizeMarketName(symbol) === normalizeMarketName(activeSymbol) ? 'active' : ''}" data-market-symbol="${esc(marketName)}|${esc(symbol)}">${esc(symbol)}</button>`)
                  .join('')}
              </div>
              <div class="book-cols compact"><span class="col-maker">MAKER</span><span class="col-qty">QTY</span><span class="col-px">PRICE</span></div>
              <div class="market-levels">
                <div>${renderMarketBookLevels(asks, 'ask-lv')}</div>
                <div id="spread-row">spread: —</div>
                <div>${renderMarketBookLevels(bids, 'bid-lv')}</div>
              </div>
            </div>
            <div class="market-chart">
              <div class="market-chart-title">PRICE CHART</div>
              ${renderMarketChartSvg(chartPoints)}
            </div>
            <div class="market-trades-section">
              <div id="trades-hdr">TRADES</div>
              <div class="market-trades-list">
                ${trades.length === 0
                  ? '<span style="color:var(--muted);font-size:10px;padding:2px 8px;display:block">No trades</span>'
                  : trades
                      .map((trade) => `<div class="tr-row ${Number(trade.quantity || 0) >= 0 ? 'tr-buy' : 'tr-sell'}">
                        <span class="td">${Number(trade.quantity || 0) >= 0 ? 'B' : 'S'}</span>
                        <span class="tp">${fmt2(Number(trade.price || 0))}</span>
                        <span class="tq">${fmtNum(Math.abs(Number(trade.quantity || 0)))}</span>
                        <span class="tt">${new Date(Number(trade.timestamp || Date.now())).toLocaleTimeString()}</span>
                      </div>`)
                      .join('')}
              </div>
            </div>
          </div>
        </div>
        <div class="market-controls"><span style="font-size:10px;color:${market.connected ? 'var(--green)' : 'var(--muted)'}">● ${market.connected ? 'CONNECTED' : 'DISCONNECTED'}</span></div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('button[data-market-symbol]').forEach((btn) => {
    const marketBtn = btn as HTMLButtonElement;
    marketBtn.onclick = () => {
      const [marketName, symbol] = String(marketBtn.dataset.marketSymbol || '').split('|');
      if (!marketName || !symbol) return;
      selectMarketSymbol(marketName, symbol);
    };
  });
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

  const bidsContainer = ge('bids-list') || ge('bids');
  const asksContainer = ge('asks-list') || ge('asks');
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
  const bookSym = ge('book-sym');
  if (bookSym) {
    bookSym.innerHTML = `ORDER BOOK &nbsp;&#8212; ${esc(book.symbol || '')}`;
  }

  // Render bids (green, highest prices first)
  if (book.bid && book.bid.length > 0) {
    bidsContainer.innerHTML = book.bid
      .slice(0, 10) // Show top 10 levels
      .map(level => {
        const pct = level.quantity > 0 ? Math.min(100, (level.quantity / 1000) * 100) : 0;
        return `<div class="bk-level bid-lv">
          <div class="bar" style="width:${pct}%"></div>
          <span class="lv-maker">MKT</span>
          <span class="lv-qty"><span class="lv-qty-num">${fmtNum(level.quantity)}</span></span>
          <span class="lv-px">${fmt2(level.price)}</span>
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
        return `<div class="bk-level ask-lv">
          <div class="bar" style="width:${pct}%"></div>
          <span class="lv-maker">MKT</span>
          <span class="lv-qty"><span class="lv-qty-num">${fmtNum(level.quantity)}</span></span>
          <span class="lv-px">${fmt2(level.price)}</span>
        </div>`;
      })
      .join('');
  } else {
    asksContainer.innerHTML = '<span style="color:var(--muted);font-size:10px">No asks</span>';
  }

  const bookLast = ge('book-last');
  if (bookLast) {
    const bestBid = book.bid && book.bid.length > 0 ? Number(book.bid[0].price || 0) : 0;
    const bestAsk = book.ask && book.ask.length > 0 ? Number(book.ask[0].price || 0) : 0;
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);
    bookLast.innerHTML = `last: ${mid > 0 ? fmt2(mid) : '&#8212;'}`;
  }

  applyDefaultLimitPriceFromBook(true);
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
        <button type="button" class="order-cancel" data-clord-id="${esc(clordId)}">×</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('button.order-cancel[data-clord-id]').forEach((btn) => {
    const cancelBtn = btn as HTMLButtonElement;
    cancelBtn.onclick = () => {
      const clOrdId = String(cancelBtn.dataset.clordId || '').trim();
      if (!clOrdId) return;
      const cancelFn = (window as any).cancelOrder;
      if (typeof cancelFn === 'function') {
        cancelFn(clOrdId);
      }
    };
  });

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

export function clearAllLogsEntries(): void {
  logEntries.length = 0;
  Object.keys(recentLogTimestamps).forEach((k) => delete recentLogTimestamps[k]);
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
  const market = getOrCreateMarket(mn);
  if (!market || !market.book || normalizeMarketName(market.book.symbol) !== sym) return;

  // If a pending order no longer appears in current UI symbol context, keep it;
  // removal is driven by player_state / execution reports, not book snapshots.
  // This hook is still useful to refresh visible order-related surfaces.
  renderOrderBook(true);
  renderSplitMarketCards();
  console.log(`[UI] Reconciled order surfaces from book: ${mn}/${sym}`);
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

  const recentTrades = market.trades
    .slice(-5) // Show last 5 trades
    .reverse() // Most recent first
    .map(trade => {
      const sideClass = Number(trade.quantity || 0) >= 0 ? 'tr-buy' : 'tr-sell';
      return `<div class="tr-row ${sideClass}">
        <span class="td">${Number(trade.quantity || 0) >= 0 ? 'B' : 'S'}</span>
        <span class="to">MKT</span>
        <span class="tp">${fmt2(trade.price)}</span>
        <span class="tq">${fmtNum(Math.abs(Number(trade.quantity || 0)))}</span>
        <span class="tt">${new Date(trade.timestamp).toLocaleTimeString()}</span>
      </div>`;
    })
    .join('');

  list.innerHTML = recentTrades;

  const lastTrade = market.trades[market.trades.length - 1];
  const bookLast = ge('book-last');
  if (bookLast && lastTrade && Number(lastTrade.price || 0) > 0) {
    bookLast.innerHTML = `last: ${fmt2(lastTrade.price)}`;
  }

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
 * Default order price from top of book:
 * BUY -> best ask, SELL -> best bid.
 * When force=false, only applies if current price is empty/invalid.
 */
export function applyDefaultLimitPriceFromBook(force: boolean = false): void {
  const priceInput = ge('o-price') as HTMLInputElement | null;
  if (!priceInput) return;

  const currentPrice = Number(priceInput.value || 0);
  if (!force && Number.isFinite(currentPrice) && currentPrice > 0) {
    return;
  }

  const marketName = getSelectedOrderMarketName();
  const market = getOrCreateMarket(marketName);
  if (!market) return;

  const symbolSelect = ge('o-sym') as HTMLSelectElement | null;
  const activeSymbol = normalizeMarketName(
    symbolSelect?.value || getActiveMarketSymbol(marketName)
  );
  if (!activeSymbol) return;

  const book = (market.books && market.books[activeSymbol]) || market.book;
  if (!book) return;

  const bestBid = Array.isArray(book.bid) && book.bid.length > 0
    ? Math.max(...book.bid.map((l: any) => Number(l?.price || 0)).filter((p: number) => Number.isFinite(p) && p > 0))
    : 0;
  const bestAsk = Array.isArray(book.ask) && book.ask.length > 0
    ? Math.min(...book.ask.map((l: any) => Number(l?.price || 0)).filter((p: number) => Number.isFinite(p) && p > 0))
    : 0;

  const nextPrice = getTradingSide() === 'BUY' ? bestAsk : bestBid;
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) return;

  const priceRange = ge('o-price-range') as HTMLInputElement | null;
  if (priceRange) {
    const min = Number(priceRange.min || 0);
    const max = Number(priceRange.max || Number.MAX_SAFE_INTEGER);
    const clamped = Math.min(max, Math.max(min, nextPrice));
    priceInput.value = String(clamped);
    priceRange.value = String(clamped);
  } else {
    priceInput.value = String(nextPrice);
  }

  priceInput.dispatchEvent(new Event('input', { bubbles: true }));
  renderOrderCostPreview();
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
