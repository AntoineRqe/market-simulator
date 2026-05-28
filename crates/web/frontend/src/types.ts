// ============================================================================
// Type definitions for the multi-market terminal
// ============================================================================

export interface MarketConfig {
  name: string;
  url?: string;
  stocks?: string[];
}

export interface MarketTokenEntry {
  url?: string;
  token?: string;
}

export interface MarketTokens {
  [marketName: string]: MarketTokenEntry;
}

export interface Player {
  username: string;
  is_admin: boolean;
  token_balance: number;
  visitor_count: number;
  total_visitors: number;
}

export interface OrderLevel {
  price: number;
  quantity: number;
  numOrders: number;
}

export interface MarketBook {
  symbol: string;
  bid: OrderLevel[];
  ask: OrderLevel[];
  lastTrade?: {
    price: number;
    quantity: number;
    timestamp: number;
  };
}

export interface Order {
  cl_ord_id: string;
  order_id?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  status: string;
  filled: number;
  avgPrice?: number;
  timestamp: number;
  username?: string;
}

export interface Trade {
  price: number;
  quantity: number;
  timestamp: number;
  side?: 'BUY' | 'SELL';
}

export interface ChartPoint {
  price: number;
  quantity: number;
  timestamp: number;
}

export interface MarketState {
  name: string;
  connected: boolean;
  activeSymbol: string;
  book?: MarketBook;
  orders: Order[];
  trades: Trade[];
  chartPoints: ChartPoint[];
}

export interface UIState {
  side: 'BUY' | 'SELL';
  activeLogTab: string;
  mobileActiveMarket: string;
  currentPlayerSuffix: string;
  currentPlayer: string | null;
  currentIsAdmin: boolean;
  currentVisitorCount: number;
  currentTotalVisitorCount: number;
  lastTokenBalance: number | null;
}

export interface Holdings {
  [symbol: string]: {
    quantity: number;
    avgPrice: number;
  };
}

export interface OrderOwners {
  [clOrdId: string]: string;
}
