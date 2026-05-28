// ============================================================================
// Main entry point for the multi-market terminal
// ============================================================================

import { setTemplateConfig, FRONTEND_BUILD_TAG } from './constants.js';
import { initializeAuth, requireAuth, getMarketTokens, normalizeMarketTokenUrls, logout } from './auth.js';
import {
  setCurrentPlayer,
  setTradingSide,
  getTradingSide,
  renderMarketTabs,
  renderSymbolTabs,
  renderSplitMarketCards,
  renderOrderCostPreview,
  applyDefaultLimitPriceFromBook,
  selectMarketSymbol,
  selectOrderMarket,
  setActiveLogTab,
  clearAllLogsEntries,
  getOpenOrders,
} from './ui.js';
import { addMarket, getPrimaryMarketName, resolveSplitMarketConfigs, getSelectedOrderMarketName, getOrCreateMarket } from './market.js';
import { connectAllMarkets, disconnectAllMarkets } from './websocket.js';
import { normalizeMarketName, log, ge } from './utils.js';
import { placeOrder } from './trading.js';

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

  renderMarketTabs();
  renderSymbolTabs();
  renderSplitMarketCards();
}

function syncOrderInputFromSlider(inputId: string): void {
  const textInput = document.getElementById(inputId) as HTMLInputElement | null;
  const rangeInput = document.getElementById(`${inputId}-range`) as HTMLInputElement | null;
  if (!textInput || !rangeInput) return;

  textInput.value = rangeInput.value;
  renderOrderCostPreview();
  updateSendButtonState();
}

function syncOrderSliderFromInput(inputId: string): void {
  const textInput = document.getElementById(inputId) as HTMLInputElement | null;
  const rangeInput = document.getElementById(`${inputId}-range`) as HTMLInputElement | null;
  if (!textInput || !rangeInput) return;

  const min = Number(rangeInput.min || 0);
  const max = Number(rangeInput.max || Number.MAX_SAFE_INTEGER);
  const raw = Number(textInput.value || 0);
  const clamped = Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min));
  rangeInput.value = String(clamped);
  textInput.value = String(clamped);
  renderOrderCostPreview();
  updateSendButtonState();
}

function updateSendButtonState(): void {
  const sendBtn = document.getElementById('btn-send') as HTMLButtonElement | null;
  const sym = document.getElementById('o-sym') as HTMLSelectElement | null;
  const qty = document.getElementById('o-qty') as HTMLInputElement | null;
  const px = document.getElementById('o-price') as HTMLInputElement | null;
  if (!sendBtn) return;

  const symbol = normalizeMarketName(sym?.value || '');
  const quantity = Number(qty?.value || 0);
  const price = Number(px?.value || 0);
  sendBtn.disabled = !(symbol && quantity > 0 && price > 0);
}

function applySideButtonState(): void {
  const side = getTradingSide();
  const buyBtn = document.getElementById('btn-buy') as HTMLButtonElement | null;
  const sellBtn = document.getElementById('btn-sell') as HTMLButtonElement | null;
  const sendBtn = document.getElementById('btn-send') as HTMLButtonElement | null;
  if (buyBtn && sellBtn) {
    if (side === 'BUY') {
      buyBtn.style.background = 'var(--green)';
      buyBtn.style.color = '#0d0f14';
      buyBtn.style.opacity = '1';
      sellBtn.style.background = '#1a1e2a';
      sellBtn.style.color = 'var(--muted)';
      sellBtn.style.opacity = '0.6';
    } else {
      buyBtn.style.background = '#1a1e2a';
      buyBtn.style.color = 'var(--muted)';
      buyBtn.style.opacity = '0.6';
      sellBtn.style.background = 'var(--red)';
      sellBtn.style.color = '#0d0f14';
      sellBtn.style.opacity = '1';
    }
  }
  if (sendBtn) {
    sendBtn.classList.toggle('sell', side === 'SELL');
    sendBtn.textContent = side === 'BUY' ? '▶  BUY ORDER' : '▶  SELL ORDER';
  }
  updateSendButtonState();
}

async function sendOrderFromForm(): Promise<void> {
  const sym = document.getElementById('o-sym') as HTMLSelectElement | null;
  const qty = document.getElementById('o-qty') as HTMLInputElement | null;
  const px = document.getElementById('o-price') as HTMLInputElement | null;
  if (!sym || !qty || !px) return;

  const symbol = normalizeMarketName(sym.value || '');
  const quantity = Number(qty.value || 0);
  const price = Number(px.value || 0);
  if (!symbol || quantity <= 0 || price <= 0) return;

  const order = await placeOrder(symbol, quantity, price);
  if (!order) {
    updateSendButtonState();
    return;
  }

  const selectedMarket = getSelectedOrderMarketName();
  const market = getOrCreateMarket(selectedMarket);
  const ws = market?.ws as WebSocket | null;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error(`[Trading] Cannot send order: market socket not connected (${selectedMarket})`);
    updateSendButtonState();
    return;
  }

  const sideCode = order.side === 'BUY' ? '1' : '2';
  ws.send(
    JSON.stringify({
      action: 'order',
      clord_id: order.cl_ord_id,
      symbol: order.symbol,
      qty: order.quantity,
      price: order.price,
      side: sideCode,
      sender: sessionStorage.getItem('auth_username') || undefined,
    })
  );

  updateSendButtonState();
}

function cancelOrderById(clOrdId: string): void {
  const normalizedId = String(clOrdId || '').trim();
  if (!normalizedId) return;

  const order = getOpenOrders()[normalizedId];
  const payload: Record<string, unknown> = {
    action: 'cancel',
    clord_id: normalizedId,
  };
  if (order?.symbol) payload.symbol = order.symbol;
  if (typeof order?.quantity === 'number') payload.qty = order.quantity;

  const selectedMarket = getSelectedOrderMarketName();
  const selectedWs = getOrCreateMarket(selectedMarket)?.ws as WebSocket | null;
  if (selectedWs && selectedWs.readyState === WebSocket.OPEN) {
    selectedWs.send(JSON.stringify(payload));
    return;
  }

  const marketNames = resolveSplitMarketConfigs()
    .map((m) => normalizeMarketName(m.name || ''))
    .filter(Boolean);
  for (const marketName of marketNames) {
    const ws = getOrCreateMarket(marketName)?.ws as WebSocket | null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return;
    }
  }

  console.error(`[Trading] Cannot cancel order ${normalizedId}: no connected market socket`);
}

function installLegacyUiHandlers(): void {
  // Keep compatibility with inline HTML handlers used by the template.
  (window as any).syncOrderInputFromSlider = (inputId: string) => syncOrderInputFromSlider(inputId);
  (window as any).setSide = (side: 'BUY' | 'SELL') => {
    setTradingSide(side);
    applySideButtonState();
    applyDefaultLimitPriceFromBook(true);
    renderOrderCostPreview();
    updateSendButtonState();
  };
  (window as any).sendOrder = () => {
    void sendOrderFromForm();
  };
  (window as any).cancelOrder = (clOrdId: string) => {
    cancelOrderById(clOrdId);
  };
  (window as any).showLogTab = (tab: string) => {
    setActiveLogTab(tab);
  };
  (window as any).clearAllLogs = () => {
    clearAllLogsEntries();
    const fix = document.getElementById('fix-log-box');
    const md = document.getElementById('md-log-box');
    if (fix) fix.innerHTML = '';
    if (md) md.innerHTML = '';
  };
  (window as any).showTab = (tabId: string) => {
    ['col-left', 'col-book', 'col-log', 'markets-container'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active', id === tabId);
    });
    const mapping: Record<string, string> = {
      'col-left': 'tab-left',
      'col-book': 'tab-book',
      'col-log': 'tab-log',
    };
    ['tab-left', 'tab-book', 'tab-log'].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.toggle('active', id === mapping[tabId]);
    });
  };
  (window as any).switchMarket = () => {
    const markets = resolveSplitMarketConfigs()
      .map((m) => normalizeMarketName(m.name || ''))
      .filter(Boolean);
    if (markets.length === 0) return;
    const current = getSelectedOrderMarketName();
    const idx = Math.max(0, markets.indexOf(current));
    const next = markets[(idx + 1) % markets.length];
    selectOrderMarket(next);
  };
  (window as any).disconnect = () => {
    disconnectAllMarkets();
    logout();
  };
  (window as any).sendToSelectedMarket = (payload: Record<string, unknown>) => {
    const marketName = getSelectedOrderMarketName();
    const market = getOrCreateMarket(marketName);
    const ws = market?.ws as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };
  (window as any).clearBookAllMarkets = () => {
    const markets = resolveSplitMarketConfigs()
      .map((m) => normalizeMarketName(m.name || ''))
      .filter(Boolean);
    markets.forEach((marketName) => {
      const ws = getOrCreateMarket(marketName)?.ws as WebSocket | null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'clear_book' }));
      }
    });
  };
  (window as any).resetTokensAllMarkets = () => {
    const markets = resolveSplitMarketConfigs()
      .map((m) => normalizeMarketName(m.name || ''))
      .filter(Boolean);
    markets.forEach((marketName) => {
      const ws = getOrCreateMarket(marketName)?.ws as WebSocket | null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'reset_tokens' }));
      }
    });
  };
  (window as any).ge = ge;

  const qtyInput = document.getElementById('o-qty') as HTMLInputElement | null;
  const qtyRange = document.getElementById('o-qty-range') as HTMLInputElement | null;
  const priceInput = document.getElementById('o-price') as HTMLInputElement | null;
  const priceRange = document.getElementById('o-price-range') as HTMLInputElement | null;
  const symSelect = document.getElementById('o-sym') as HTMLSelectElement | null;
  const marketSelect = document.getElementById('o-market') as HTMLSelectElement | null;

  qtyInput?.addEventListener('input', () => syncOrderSliderFromInput('o-qty'));
  qtyRange?.addEventListener('input', () => syncOrderInputFromSlider('o-qty'));
  priceInput?.addEventListener('input', () => syncOrderSliderFromInput('o-price'));
  priceRange?.addEventListener('input', () => syncOrderInputFromSlider('o-price'));

  symSelect?.addEventListener('change', () => {
    const selectedMarket = getSelectedOrderMarketName();
    selectMarketSymbol(selectedMarket, symSelect.value || '');
    applyDefaultLimitPriceFromBook(true);
    updateSendButtonState();
  });
  marketSelect?.addEventListener('change', () => {
    const selected = normalizeMarketName(marketSelect.value || '');
    if (selected) {
      selectOrderMarket(selected);
    } else {
      renderSymbolTabs();
    }
    applyDefaultLimitPriceFromBook(true);
    updateSendButtonState();
  });

  syncOrderSliderFromInput('o-qty');
  syncOrderSliderFromInput('o-price');
  applySideButtonState();
  applyDefaultLimitPriceFromBook(true);
  updateSendButtonState();
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
    installLegacyUiHandlers();

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
