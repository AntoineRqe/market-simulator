use std::collections::VecDeque;

use types::{
    FixedPointArithmetic, OrderEvent, OrderResult, OrderStatus, Side, Trade, Trades,
    macros::OrderId,
};
use utils::market_name;

use super::OrderBook;

#[derive(Debug, Clone, Copy)]
pub(super) struct OrderRef {
    pub(super) side: Side,
    pub(super) price: FixedPointArithmetic,
}

impl OrderRef {
    pub(super) fn new(side: Side, price: FixedPointArithmetic) -> Self {
        Self { side, price }
    }
}

#[derive(Debug, Clone)]
pub struct PriceLevel {
    pub(super) orders: VecDeque<OrderEvent>,
}

impl Default for PriceLevel {
    fn default() -> Self {
        Self {
            orders: VecDeque::new(),
        }
    }
}

impl PriceLevel {
    fn head_order(&self) -> Option<&OrderEvent> {
        self.orders.front()
    }
}

impl OrderBook {
    pub(super) fn collect_level_orders(&self, level: &PriceLevel) -> Vec<OrderEvent> {
        level.orders.iter().copied().collect()
    }

    fn append_order(&mut self, side: Side, price: FixedPointArithmetic, order: OrderEvent) -> bool {
        let idx = match Self::price_to_index(price) {
            Some(i) => i,
            None => return false, // Silently ignore out-of-range prices
        };

        let levels = self.levels_mut(side);
        let is_new_level = levels[idx].is_none();
        if levels[idx].is_none() {
            levels[idx] = Some(PriceLevel::default());
        }
        if let Some(level) = &mut levels[idx] {
            level.orders.push_back(order);
        }
        if is_new_level {
            self.push_price_level(side, price);
        }
        true
    }

    fn unlink_order_by_id(
        &mut self,
        side: Side,
        price: FixedPointArithmetic,
        cl_ord_id: OrderId,
    ) -> Option<OrderEvent> {
        let idx = Self::price_to_index(price)?;
        let levels = self.levels_mut(side);

        let (order, remove_level) = {
            let level = levels.get_mut(idx)?.as_mut()?;
            let pos = level
                .orders
                .iter()
                .position(|order| order.cl_ord_id == cl_ord_id)?;
            let order = level.orders.remove(pos)?;
            (order, level.orders.is_empty())
        };

        if remove_level {
            levels[idx] = None;
            self.prune_price_heap(side);
        }

        Some(order)
    }

    pub(super) fn add_resting_order(&mut self, order: OrderEvent) {
        let appended = self.append_order(order.side, order.price, order);
        if !appended {
            return;
        }
        self.order_map
            .insert(order.cl_ord_id, OrderRef::new(order.side, order.price));
        tracing::debug!(
            "[{}][{}][{}] Added order with ID: {}, side: {:?}, price: {} to order map",
            market_name(),
            order.symbol,
            order.cl_ord_id,
            order.cl_ord_id,
            order.side,
            order.price
        );
    }

    pub(super) fn process_cancel_order(&mut self, order: OrderEvent) -> (OrderEvent, OrderResult) {
        let orig_cl_ord_id = if let Some(orig_cl_ord_id) = order.orig_cl_ord_id {
            orig_cl_ord_id
        } else {
            tracing::error!(
                "[{}][{}][{}] Cancel order with ID: {} is missing original client order ID, cannot process cancellation",
                market_name(),
                order.symbol,
                order.cl_ord_id,
                order.cl_ord_id
            );
            return (
                order,
                self.build_order_result(OrderStatus::CancelRejected, None),
            );
        };

        if let Some(order_ref) = self.order_map.get(&orig_cl_ord_id).copied() {
            if let Some(cancelled_order) =
                self.unlink_order_by_id(order_ref.side, order_ref.price, orig_cl_ord_id)
            {
                let mut cancel_ack = order;
                cancel_ack.side = cancelled_order.side;
                cancel_ack.price = cancelled_order.price;
                cancel_ack.quantity = cancelled_order.quantity;

                tracing::debug!(
                    "[{}][{}][{}] Cancelled order with ID: {}, side: {:?}, price: {}",
                    market_name(),
                    order.symbol,
                    order.cl_ord_id,
                    orig_cl_ord_id,
                    order_ref.side,
                    order_ref.price
                );

                self.order_map.remove(&orig_cl_ord_id);
                return (
                    cancel_ack,
                    self.build_order_result(OrderStatus::Cancelled, None),
                );
            }
        }

        (
            order,
            self.build_order_result(OrderStatus::CancelRejected, None),
        )
    }

    pub(super) fn process_sell_limit_order(
        &mut self,
        order: OrderEvent,
    ) -> (OrderEvent, OrderResult) {
        let mut remaining_quantity = order.quantity;
        let mut trades: Option<Trades<4>> = None;
        self.prune_price_heap(Side::Buy);

        while let Some(best_bid_price) = self.best_price(Side::Buy) {
            if best_bid_price < order.price {
                break;
            }

            while remaining_quantity > FixedPointArithmetic::ZERO {
                let best_bid_idx = match Self::price_to_index(best_bid_price) {
                    Some(i) => i,
                    None => break,
                };

                let best_bid = match self
                    .bids
                    .get(best_bid_idx)
                    .and_then(|opt| opt.as_ref())
                    .and_then(|level| level.head_order())
                    .copied()
                {
                    Some(order) => order,
                    None => break,
                };

                let maker_qty_before = best_bid.quantity;
                let trade_quantity = remaining_quantity.min(maker_qty_before);
                remaining_quantity -= trade_quantity;

                let (maker_leaves_qty, remove_level) = {
                    let level = self
                        .bids
                        .get_mut(best_bid_idx)
                        .and_then(|opt| opt.as_mut())
                        .expect("best bid level missing during match");
                    let maker = level
                        .orders
                        .front_mut()
                        .expect("best bid order missing during match");
                    maker.quantity -= trade_quantity;
                    let maker_leaves_qty = maker.quantity;
                    if maker_leaves_qty == FixedPointArithmetic::ZERO {
                        level.orders.pop_front();
                    }
                    (maker_leaves_qty, level.orders.is_empty())
                };

                if remove_level {
                    self.bids[best_bid_idx] = None;
                    self.prune_price_heap(Side::Buy);
                }

                if maker_leaves_qty == FixedPointArithmetic::ZERO {
                    self.order_map.remove(&best_bid.cl_ord_id);
                }

                if let Err(_) = trades.get_or_insert_with(Trades::default).add_trade(Trade {
                    price: best_bid.price,
                    cl_ord_id: best_bid.cl_ord_id,
                    sender_id: best_bid.sender_id,
                    target_id: best_bid.target_id,
                    quantity: trade_quantity,
                    id: self.generate_trade_id(),
                    order_qty: maker_qty_before,
                    leaves_qty: maker_leaves_qty,
                    ..Default::default()
                }) {
                    tracing::error!(
                        "[{}][{}][{}] Maximum number of trades reached for this order, some trades may not be recorded in the OrderResult",
                        market_name(),
                        order.symbol,
                        order.cl_ord_id
                    );
                }

                if remaining_quantity == FixedPointArithmetic::ZERO {
                    return self.generate_order_result(order, trades);
                }
            }
        }

        let (order, order_result) = self.generate_order_result(order, trades);

        if remaining_quantity > FixedPointArithmetic::ZERO {
            let mut resting_order = order;
            resting_order.quantity = remaining_quantity;
            self.add_resting_order(resting_order);
        }

        (order, order_result)
    }

    pub(super) fn process_buy_limit_order(
        &mut self,
        order: OrderEvent,
    ) -> (OrderEvent, OrderResult) {
        let mut remaining_quantity = order.quantity;
        let mut trades: Option<Trades<4>> = None;
        self.prune_price_heap(Side::Sell);
        while let Some(best_ask_price) = self.best_price(Side::Sell) {
            if best_ask_price > order.price {
                break;
            }

            while remaining_quantity > FixedPointArithmetic::ZERO {
                let best_ask_idx = match Self::price_to_index(best_ask_price) {
                    Some(i) => i,
                    None => break,
                };

                let best_ask = match self
                    .asks
                    .get(best_ask_idx)
                    .and_then(|opt| opt.as_ref())
                    .and_then(|level| level.head_order())
                    .copied()
                {
                    Some(order) => order,
                    None => break,
                };

                let maker_qty_before = best_ask.quantity;
                let trade_quantity = remaining_quantity.min(maker_qty_before);
                remaining_quantity -= trade_quantity;

                let (maker_leaves_qty, remove_level) = {
                    let level = self
                        .asks
                        .get_mut(best_ask_idx)
                        .and_then(|opt| opt.as_mut())
                        .expect("best ask level missing during match");
                    let maker = level
                        .orders
                        .front_mut()
                        .expect("best ask order missing during match");
                    maker.quantity -= trade_quantity;
                    let maker_leaves_qty = maker.quantity;
                    if maker_leaves_qty == FixedPointArithmetic::ZERO {
                        level.orders.pop_front();
                    }
                    (maker_leaves_qty, level.orders.is_empty())
                };

                if remove_level {
                    self.asks[best_ask_idx] = None;
                    self.prune_price_heap(Side::Sell);
                }

                if maker_leaves_qty == FixedPointArithmetic::ZERO {
                    self.order_map.remove(&best_ask.cl_ord_id);
                }

                if let Err(_) = trades.get_or_insert_with(Trades::default).add_trade(Trade {
                    price: best_ask.price,
                    cl_ord_id: best_ask.cl_ord_id,
                    sender_id: best_ask.sender_id,
                    target_id: best_ask.target_id,
                    quantity: trade_quantity,
                    id: self.generate_trade_id(),
                    order_qty: maker_qty_before,
                    leaves_qty: maker_leaves_qty,
                    ..Default::default()
                }) {
                    tracing::error!(
                        "[{}][{}][{}] Maximum number of trades reached for this order, some trades may not be recorded in the OrderResult",
                        market_name(),
                        order.symbol,
                        order.cl_ord_id
                    );
                }

                if remaining_quantity == FixedPointArithmetic::ZERO {
                    return self.generate_order_result(order, trades);
                }
            }
        }

        let (order, order_result) = self.generate_order_result(order, trades);

        if remaining_quantity > FixedPointArithmetic::ZERO {
            let mut resting_order = order;
            resting_order.quantity = remaining_quantity;
            self.add_resting_order(resting_order);
        }

        (order, order_result)
    }

    pub fn get_best_bid(&self) -> Option<&OrderEvent> {
        let price = self.best_price(Side::Buy)?;
        let idx = Self::price_to_index(price)?;
        self.bids.get(idx)?.as_ref()?.orders.front()
    }

    pub fn get_best_ask(&self) -> Option<&OrderEvent> {
        let price = self.best_price(Side::Sell)?;
        let idx = Self::price_to_index(price)?;
        self.asks.get(idx)?.as_ref()?.orders.front()
    }
}
