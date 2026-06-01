use std::collections::VecDeque;

use types::{
    FixedPointArithmetic, OrderEvent, OrderResult, OrderStatus, Side, Trade, Trades,
    macros::OrderId,
};
use utils::market_name;

use super::OrderBook;

pub(super) type OrderRef = OrderEvent;

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

    fn append_order(&mut self, side: Side, price: FixedPointArithmetic, order: OrderEvent) {
        let level = self.levels_mut(side).entry(price).or_default();
        level.orders.push_back(order);
    }

    fn unlink_order_by_id(
        &mut self,
        side: Side,
        price: FixedPointArithmetic,
        cl_ord_id: OrderId,
    ) -> Option<OrderEvent> {
        let (order, remove_level) = {
            let level = self
                .levels_mut(side)
                .get_mut(&price)
                .expect("price level missing for order");
            let pos = level.orders.iter().position(|order| order.cl_ord_id == cl_ord_id)?;
            let order = level.orders.remove(pos)?;
            (order, level.orders.is_empty())
        };

        if remove_level {
            self.levels_mut(side).remove(&price);
        }

        Some(order)
    }

    pub(super) fn add_resting_order(&mut self, order: OrderEvent) {
        self.append_order(order.side, order.price, order);
        self.order_map.insert(order.cl_ord_id, order);
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

    pub(super) fn process_sell_limit_order(&mut self, order: OrderEvent) -> (OrderEvent, OrderResult) {
        let mut remaining_quantity = order.quantity;
        let mut trades: Option<Trades<4>> = None;

        while let Some(best_bid_price) = self.best_price(Side::Buy) {
            if best_bid_price < order.price {
                break;
            }

            while remaining_quantity > FixedPointArithmetic::ZERO {
                let best_bid = match self
                    .bids
                    .get(&best_bid_price)
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
                        .get_mut(&best_bid_price)
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
                    self.bids.remove(&best_bid_price);
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

        let order_result = self.generate_order_result(order, trades);

        if remaining_quantity > FixedPointArithmetic::ZERO {
            let mut resting_order = order;
            resting_order.quantity = remaining_quantity;
            self.add_resting_order(resting_order);
        }

        order_result
    }

    pub(super) fn process_buy_limit_order(&mut self, order: OrderEvent) -> (OrderEvent, OrderResult) {
        let mut remaining_quantity = order.quantity;
        let mut trades: Option<Trades<4>> = None;
        while let Some(best_ask_price) = self.best_price(Side::Sell) {
            if best_ask_price > order.price {
                break;
            }

            while remaining_quantity > FixedPointArithmetic::ZERO {
                let best_ask = match self
                    .asks
                    .get(&best_ask_price)
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
                        .get_mut(&best_ask_price)
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
                    self.asks.remove(&best_ask_price);
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
        let (_price, level) = self.bids.last_key_value()?;
        level.head_order()
    }

    pub fn get_best_ask(&self) -> Option<&OrderEvent> {
        let (_price, level) = self.asks.first_key_value()?;
        level.head_order()
    }
}
