// ============================================================================
// Order placement and trading logic
// ============================================================================

import { getCurrentPlayer, getCurrentPlayerSuffix, getTradingSide, currentHoldings } from './ui.js';
import { normalizeMarketName } from './utils.js';
import type { Order } from './types.js';

/**
 * Place a new order (BUY or SELL)
 */
export async function placeOrder(
  symbol: string,
  quantity: number,
  price: number
): Promise<Order | null> {
  const player = getCurrentPlayer();
  if (!player) {
    console.error('[Trading] No authenticated player');
    return null;
  }

  const side = getTradingSide();
  const symbol_normalized = normalizeMarketName(symbol);

  // Validate inputs
  if (!symbol_normalized || quantity <= 0 || price <= 0) {
    console.error('[Trading] Invalid order parameters', {
      symbol: symbol_normalized,
      quantity,
      price,
    });
    return null;
  }

  // Generate ClOrdID with player suffix
  const suffix = getCurrentPlayerSuffix();
  const timestamp = Date.now();
  const clOrdId = `${player}-${timestamp}${suffix ? `-${suffix}` : ''}`;

  const order: Order = {
    cl_ord_id: clOrdId,
    symbol: symbol_normalized,
    side,
    quantity,
    price,
    status: 'PENDING',
    filled: 0,
    timestamp: timestamp,
  };

  console.log('[Trading] Placing order:', order);

  // TODO: Send to backend via WebSocket or HTTP
  // const response = await sendOrderToServer(order);
  // if (response && response.order_id) {
  //   order.order_id = response.order_id;
  //   orderOwners[clOrdId] = player;
  //   return order;
  // }

  return order;
}

/**
 * Cancel an existing order
 */
export async function cancelOrder(clOrdId: string, orderId?: string): Promise<boolean> {
  if (!clOrdId && !orderId) {
    console.error('[Trading] Must provide either clOrdId or orderId');
    return false;
  }

  console.log('[Trading] Canceling order:', { clOrdId, orderId });

  // TODO: Send cancel request to backend
  // const response = await cancelOrderOnServer(clOrdId, orderId);
  // return response && response.success;

  return false;
}

/**
 * Get portfolio for current player
 */
export async function getPlayerPortfolio(): Promise<Record<string, any> | null> {
  const player = getCurrentPlayer();
  if (!player) {
    console.error('[Trading] No authenticated player');
    return null;
  }

  console.log('[Trading] Fetching portfolio for:', player);

  // TODO: Fetch from backend
  // const response = await fetchPortfolioFromServer(player);
  // if (response) {
  //   updateCurrentHoldings(response.holdings);
  //   return response;
  // }

  return null;
}

/**
 * Get buying power (available cash for orders)
 */
export function getBuyingPower(): number {
  // TODO: Calculate based on portfolio and open orders
  return 0;
}

/**
 * Get available quantity for sale (based on holdings)
 */
export function getAvailableQuantity(symbol: string): number {
  const normalized = normalizeMarketName(symbol);
  const holding = currentHoldings[normalized];
  if (!holding) return 0;
  return holding.quantity;
}

/**
 * Calculate order cost (BUY) or proceeds (SELL)
 */
export function calculateOrderValue(
  quantity: number,
  price: number,
  side?: string
): number {
  const finalSide = side || getTradingSide();
  const total = quantity * price;

  // For buys, add a conservative commission estimate
  if (finalSide === 'BUY') {
    const commission = total * 0.001; // 0.1% commission
    return total + commission;
  }

  // For sells, subtract commission
  const commission = total * 0.001;
  return total - commission;
}

/**
 * Check if an order can be placed (validate constraints)
 */
export function canPlaceOrder(
  symbol: string,
  quantity: number,
  price: number,
  side?: string
): { valid: boolean; reason?: string } {
  const finalSide = side || getTradingSide();

  // Validate quantity and price
  if (quantity <= 0) {
    return { valid: false, reason: 'Quantity must be positive' };
  }
  if (price <= 0) {
    return { valid: false, reason: 'Price must be positive' };
  }

  // Validate buying power for BUY orders
  if (finalSide === 'BUY') {
    const buyingPower = getBuyingPower();
    const orderValue = calculateOrderValue(quantity, price, 'BUY');
    if (orderValue > buyingPower) {
      return {
        valid: false,
        reason: `Insufficient buying power: need $${orderValue.toFixed(2)}, have $${buyingPower.toFixed(2)}`,
      };
    }
  }

  // Validate available quantity for SELL orders
  if (finalSide === 'SELL') {
    const available = getAvailableQuantity(symbol);
    if (quantity > available) {
      return {
        valid: false,
        reason: `Insufficient holdings: need ${quantity}, have ${available}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Update holdings from portfolio data
 */
export function updateCurrentHoldings(holdings: Record<string, any>): void {
  Object.entries(holdings).forEach(([symbol, data]) => {
    const normalized = normalizeMarketName(symbol);
    currentHoldings[normalized] = {
      quantity: data.quantity || 0,
      avgPrice: data.avgPrice || 0,
    };
  });
}

/**
 * Apply execution to an order
 */
export function applyOrderExecution(
  clOrdId: string,
  filledQuantity: number,
  fillPrice: number
): void {
  console.log('[Trading] Execution:', { clOrdId, filledQuantity, fillPrice });

  // TODO: Update order state
  // - Update filled quantity
  // - Update status if fully filled
  // - Update holdings if execution is from us
}

/**
 * Handle rejection of an order
 */
export function handleOrderRejection(
  clOrdId: string,
  reason: string
): void {
  console.log('[Trading] Order rejected:', { clOrdId, reason });

  // TODO: Update order status to REJECTED
  // TODO: Show error message to user
}

/**
 * Format order for display
 */
export function formatOrder(order: Order): string {
  return `${order.side} ${order.quantity}@${order.price.toFixed(2)} ${order.symbol}`;
}

/**
 * Get pending orders for a symbol
 */
export function getPendingOrdersForSymbol(_symbol: string): Order[] {
  // TODO: Return pending orders from state
  return [];
}

/**
 * Get all pending orders
 */
export function getAllPendingOrders(): Order[] {
  // TODO: Return all pending orders from state
  return [];
}
