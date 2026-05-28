// ============================================================================
// WebSocket message handlers and event routing
// ============================================================================

import { normalizeMarketName, now, esc, fmt2, fmtNum } from './utils.js';
import { getPrimaryMarketName, getOrCreateMarket, setActiveMarketSymbol } from './market.js';
import {
  updatePlayerState,
  updateTokenBalance,
  currentHoldings,
  getCurrentHoldings,
  getOrderOwners,
  getOpenOrders,
  setOpenOrder,
  deleteOpenOrder,
  getTerminalStatusForOrder,
  setTerminalStatusForOrder,
  renderOrders,
  renderOrderBook,
  renderSplitMarketCards,
  renderHoldings,
  renderTradesPanel,
  appendLog,
} from './ui.js';
import type { Trade, MarketBook } from './types.js';

// Track pending timeout timers for orders
const pendingTimeoutMap: Record<string, ReturnType<typeof setTimeout> | null> = {};

/**
 * Handle incoming WebSocket message from server
 */
export function handleServerMessage(msg: any, marketName: string): void {
  if (!msg || typeof msg !== 'object') {
    console.warn('[Handlers] Invalid message format:', msg);
    return;
  }

  const mn = normalizeMarketName(marketName || getPrimaryMarketName());
  console.debug(`[WsEvent @ ${mn}]`, msg);

  try {
    switch (msg.type) {
      case 'status':
        handleStatusMessage(msg, mn);
        break;
      case 'player_state':
        handlePlayerStateMessage(msg, mn);
        break;
      case 'visitor_count':
        handleVisitorCountMessage(msg);
        break;
      case 'order_book':
        handleOrderBookMessage(msg, mn);
        break;
      case 'trades':
        handleTradesMessage(msg, mn);
        break;
      case 'fix_message':
        handleFixMessage(msg, mn);
        break;
      default:
        console.warn('[Handlers] Unknown message type:', msg.type);
    }
  } catch (err) {
    console.error('[Handlers] Error processing message:', err, msg);
  }
}

/**
 * Handle status message (connection state)
 */
function handleStatusMessage(msg: any, marketName: string): void {
  const connected = !!msg.connected;
  console.log(`[Status @ ${marketName}]`, connected ? 'CONNECTED' : 'DISCONNECTED');

  const market = getOrCreateMarket(marketName);
  market.connected = connected;

  updateWsIndicator(connected);
  renderSplitMarketCards();
  logServerEvent({
    ts: now(),
    label: connected ? 'CONNECTED' : 'DISCONNECTED',
    body: `Market: ${marketName}`,
    tag: connected ? 'info' : 'warn',
  });
}

/**
 * Handle player state message (portfolio, holdings, pending orders)
 */
function handlePlayerStateMessage(msg: any, marketName: string): void {
  const primaryMarketName = getPrimaryMarketName();

  // Only process player state from primary market
  if (normalizeMarketName(marketName) !== normalizeMarketName(primaryMarketName)) {
    return;
  }

  // Defer the update so rapid bursts coalesce
  schedulePlayerStateUpdate(msg);
}

/**
 * Schedule player state update with debounce (200ms)
 */
let playerStateUpdateTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePlayerStateUpdate(msg: any): void {
  // Update token balance immediately so it feels responsive
  const tokens = Number(msg.tokens || 0);
  const lastBalance = getCurrentHoldings().tokens || 0;

  if (lastBalance !== tokens && Math.abs(tokens - lastBalance) > 1e-9) {
    const delta = tokens - lastBalance;
    const sign = delta >= 0 ? '+' : '';
    logServerEvent({
      ts: now(),
      label: 'TOKENS',
      body: `${sign}${delta.toFixed(2)} (balance: ${tokens.toFixed(2)})`,
      tag: delta >= 0 ? 'info' : 'err',
    });
  }

  updateTokenBalance(tokens);

  // Defer orders panel repaint to batch updates
  if (playerStateUpdateTimer) clearTimeout(playerStateUpdateTimer);
  playerStateUpdateTimer = setTimeout(() => {
    playerStateUpdateTimer = null;
    applyPlayerStateUpdate(msg);
  }, 200);
}

/**
 * Apply player state to UI (holdings, pending orders, admin status)
 */
function applyPlayerStateUpdate(msg: any): void {
  // Update player info
  updatePlayerState({
    username: msg.username || null,
    is_admin: !!msg.is_admin,
    token_balance: Number(msg.tokens || 0),
    visitor_count: Number(msg.visitor_count || 0),
    total_visitors: Number(msg.total_visitor_count || 0),
  });

  // Update holdings
  const holdings = msg && typeof msg.holdings === 'object' && msg.holdings ? msg.holdings : {};
  Object.keys(currentHoldings).forEach((symbol) => {
    delete currentHoldings[symbol];
  });
  Object.keys(holdings).forEach(symbol => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const holding = holdings[symbol] || {};
    const qty = Number(holding.quantity || 0);
    const avgPrice = Number(holding.avg_price ?? holding.avgPrice ?? 0);
    if (normalizedSymbol) {
      currentHoldings[normalizedSymbol] = {
        quantity: qty,
        avgPrice,
      };
    }
    if (normalizedSymbol && qty > 0) {
      console.log(`[Holdings] ${normalizedSymbol}: ${qty} @ ${avgPrice}`);
    }
  });

  // Update order owners
  const owners = msg && typeof msg.order_owners === 'object' && msg.order_owners ? msg.order_owners : {};
  Object.keys(owners).forEach(clOrdId => {
    const key = String(clOrdId || '').trim();
    const username = String(owners[clOrdId] || '').trim();
    if (key && username) {
      getOrderOwners()[key] = username;
    }
  });

  // Update pending orders
  const pending = Array.isArray(msg.pending_orders) ? msg.pending_orders : [];
  pending.forEach(o => {
    if (!o || !o.cl_ord_id) return;

    // Skip if order already has terminal status
    if (getTerminalStatusForOrder(o.cl_ord_id)) {
      return;
    }

    clearPendingTimeout(o.cl_ord_id);

    // Determine market for this order
    const existingOrder = getOpenOrders()[o.cl_ord_id];
    const symbol = normalizeMarketName(o.symbol || '');
    const market = existingOrder ? existingOrder.market : getPrimaryMarketName();

    setOpenOrder(o.cl_ord_id, {
      cl_ord_id: o.cl_ord_id,
      symbol,
      side: String(o.side || '1') as 'BUY' | 'SELL',
      quantity: Number(o.qty || 0),
      price: Number(o.price || 0),
      status: 'PENDING',
      filled: 0,
      timestamp: now(),
    });
  });

  // Remove orders that are no longer in pending list but don't have terminal status
  Object.keys(getOpenOrders()).forEach(clOrdId => {
    const hasTerminalStatus = !!getTerminalStatusForOrder(clOrdId);
    const stillPending = pending.some(o => o.cl_ord_id === clOrdId);

    if (!stillPending && !hasTerminalStatus) {
      deleteOpenOrder(clOrdId);
    }
  });

  console.log('[UI] Updated player state and holdings');
  renderHoldings();
  renderOrders(null, true);
}

/**
 * Handle visitor count message
 */
function handleVisitorCountMessage(msg: any): void {
  const count = Number(msg.count || 0);
  const totalCount = Number(msg.total_count || 0);

  const el = document.getElementById('visitor-count');
  if (el) {
    el.textContent = `ACTIVE: ${count} | TOTAL: ${totalCount}`;
  }
}

/**
 * Handle order book snapshot
 */
function handleOrderBookMessage(msg: any, marketName: string): void {
  const mn = normalizeMarketName(marketName);
  const market = getOrCreateMarket(mn);

  if (!market) {
    console.warn('[Book] Market not found:', mn);
    return;
  }

  const symbol = msg.symbol || market.activeSymbol || 'AAPL';
  console.log(`[BOOK SNAPSHOT] Received snapshot for ${mn}:${symbol}`, {
    bidCount: (msg.bids || []).length,
    askCount: (msg.asks || []).length,
  });

  // Create book state
  const bookState: MarketBook = {
    symbol,
    bid: processBookSide(msg.bids || []),
    ask: processBookSide(msg.asks || []),
  };

  // Store in market state
  if (!market.books) {
    market.books = {};
  }
  market.books[symbol] = bookState;
  market.book = bookState;

  if (!market.activeSymbol) {
    setActiveMarketSymbol(mn, symbol);
  }

  renderOrderBook();
  renderSplitMarketCards();
  console.log('[Book] Merged client orders from book snapshot');
}

/**
 * Process order book side (convert rows to levels)
 */
function processBookSide(rows: any[]): any[] {
  const levels: Record<string, any> = {};

  (rows || []).forEach(row => {
    const price = Number(row.price || 0);
    if (price <= 0) return;

    if (!levels[price]) {
      levels[price] = {
        price,
        quantity: 0,
        numOrders: 0,
      };
    }

    levels[price].quantity += Number(row.qty || row.quantity || 0);
    levels[price].numOrders += 1;
  });

  return Object.values(levels).sort((a, b) => b.price - a.price);
}

/**
 * Handle trades snapshot
 */
function handleTradesMessage(msg: any, marketName: string): void {
  if (!msg.trades || !Array.isArray(msg.trades)) {
    console.warn('[Trades] Invalid message format');
    return;
  }

  const mn = normalizeMarketName(marketName);
  const market = getOrCreateMarket(mn);

  if (!market) {
    console.warn('[Trades] Market not found:', mn);
    return;
  }

  console.log(`[Trades] Received ${msg.trades.length} trades for ${mn}`);

  // Group trades by symbol
  const bySymbol: Record<string, Trade[]> = {};
  msg.trades.forEach((t: any) => {
    const symbol = normalizeMarketName(t.symbol || msg.symbol || market.activeSymbol || 'AAPL');

    if (!bySymbol[symbol]) {
      bySymbol[symbol] = [];
    }

    bySymbol[symbol].push({
      price: Number(t.price || 0),
      quantity: Number(t.qty || t.quantity || 0),
      timestamp: Number(t.timestamp || now()),
    });
  });

  if (!market.tradesBySymbol) {
    market.tradesBySymbol = {};
  }
  if (!market.chartPointsBySymbol) {
    market.chartPointsBySymbol = {};
  }

  // Update per-symbol trade and chart data
  Object.keys(bySymbol).forEach(symbol => {
    const existing = Array.isArray(market.tradesBySymbol[symbol])
      ? market.tradesBySymbol[symbol]
      : [];
    const merged = [...existing, ...bySymbol[symbol]].slice(-100);
    market.tradesBySymbol[symbol] = merged;
    updateChartPoints(market, symbol, merged);
  });

  const activeSymbol = normalizeMarketName(
    market.activeSymbol || msg.symbol || Object.keys(bySymbol)[0] || ''
  );
  market.trades = market.tradesBySymbol[activeSymbol] || [];
  market.chartPoints = market.chartPointsBySymbol[activeSymbol] || [];

  console.log('[UI] Rendered trades panel');
  renderTradesPanel();
  renderSplitMarketCards();
}

/**
 * Update chart points from trades
 */
function updateChartPoints(market: any, symbol: string, trades: Trade[]): void {
  if (!market.chartPointsBySymbol) {
    market.chartPointsBySymbol = {};
  }
  market.chartPointsBySymbol[symbol] = (trades || []).slice(-100).map((trade) => ({
    price: trade.price,
    quantity: trade.quantity,
    timestamp: trade.timestamp,
  }));
}

/**
 * Handle FIX message (execution report, rejection, etc)
 */
function handleFixMessage(msg: any, marketName: string): void {
  const { body, tag, label } = msg;

  console.log(`[FIX @ ${marketName}] ${tag} | ${label}`);

  // Log the message
  logServerEvent({
    ts: now(),
    label: label || tag,
    body: body || '',
    tag: tag === 'err' ? 'err' : 'info',
  });

  // Handle rejections
  if (tag === 'err' && label && label.includes('REJECTED')) {
    const match = label.match(/\[([^\]]+)\]/);
    if (match) {
      const clordId = match[1];
      deleteOpenOrder(clordId);
      setTerminalStatusForOrder(clordId, 'REJECTED');
      logServerEvent({
        ts: now(),
        label: 'ORDER REJECTED',
        body: `ClOrdID: ${clordId}`,
        tag: 'err',
      });
    }
    requestPlayerState();
  }

  // Handle fills/partial fills
  if (body && /\b(TRADE|EXECUTION REPORT|FILLED|PARTIALLY FILLED)\b/i.test(body)) {
    // Extract order info from body if available
    parseExecutionReport(body, marketName);
    requestPlayerState();
  }

  // Handle reset
  if (tag === 'info' && typeof label === 'string' && label.startsWith('RESET ✓')) {
    resetClientMarketView(marketName);
  }
}

/**
 * Parse execution report and update order status
 */
function parseExecutionReport(body: string, marketName: string): void {
  // Extract ClOrdID from body using regex
  const clordMatch = body.match(/ClOrdID[:\s]+([^\s,\]]+)/);
  const filledMatch = body.match(/Filled[:\s]+([0-9.]+)/);
  const execTypeMatch = body.match(/ExecType[:\s]+([A-Z]+)/);

  if (clordMatch && clordMatch[1]) {
    const clordId = clordMatch[1];
    const filled = filledMatch ? Number(filledMatch[1]) : 0;
    const execType = execTypeMatch ? execTypeMatch[1] : 'FILL';

    // Update order status
    const order = getOpenOrders()[clordId];
    if (order) {
      if (execType === 'FILL') {
        setTerminalStatusForOrder(clordId, 'FILLED');
        deleteOpenOrder(clordId);
      } else if (execType === 'PARTIAL_FILL') {
        setOpenOrder(clordId, {
          ...order,
          filled,
        });
      } else if (execType === 'REJECTED') {
        setTerminalStatusForOrder(clordId, 'REJECTED');
        deleteOpenOrder(clordId);
      }
    }
  }
}

/**
 * Request updated player state from server
 */
export function requestPlayerState(): void {
  const primaryMarketName = getPrimaryMarketName();
  const primaryMarket = getOrCreateMarket(primaryMarketName);

  if (primaryMarket && primaryMarket.ws && primaryMarket.ws.readyState === WebSocket.OPEN) {
    primaryMarket.ws.send(JSON.stringify({ action: 'get_player_state' }));
  }
}

/**
 * Clear pending timeout for an order
 */
function clearPendingTimeout(clordId: string): void {
  if (pendingTimeoutMap[clordId]) {
    clearTimeout(pendingTimeoutMap[clordId]!);
    delete pendingTimeoutMap[clordId];
  }
}

/**
 * Reset client market view
 */
function resetClientMarketView(marketName: string): void {
  const market = getOrCreateMarket(marketName);
  if (!market) return;

  market.orders = [];
  market.trades = [];
  market.chartPoints = [];
  market.tradesBySymbol = {};
  market.chartPointsBySymbol = {};

  logServerEvent({
    ts: now(),
    label: 'RESET',
    body: `Market: ${marketName}`,
    tag: 'info',
  });
}

/**
 * Update WebSocket indicator
 */
export function updateWsIndicator(connected: boolean): void {
  const statusDot = document.getElementById('status-dot');
  if (statusDot) {
    statusDot.textContent = connected ? '● CONNECTED' : '● DISCONNECTED';
    statusDot.className = connected ? 'on' : '';
  }

  const wsDot = document.getElementById('ws-dot');
  if (wsDot) {
    wsDot.textContent = connected ? '● WS' : '● WS';
    wsDot.className = connected ? 'on' : '';
  }

  // Show/hide stale data badge
  const staleBadges = document.querySelectorAll('[class*="stale-badge"]');
  staleBadges.forEach(badge => {
    (badge as HTMLElement).style.display = connected ? 'none' : 'inline-block';
  });
}

/**
 * Log server event to console and UI
 */
export function logServerEvent(event: {
  ts: number;
  label: string;
  body: string;
  tag: string;
}): void {
  console.log(`[${event.tag.toUpperCase()}] ${event.label}: ${event.body}`);
  
  // Format timestamp as HH:MM:SS.mmm
  const date = new Date(event.ts);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const timeStr = `${h}:${m}:${s}.${ms}`;
  
  appendLog({
    ts: timeStr,
    label: event.label,
    body: event.body,
    tag: event.tag,
  });
}
