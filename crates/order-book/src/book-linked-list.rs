use types::{FixedPointArithmetic, OrderEvent, OrderResult, OrderStatus, Side, Trade, Trades};
use utils::market_name;

use super::OrderBook;

pub(super) type NodeId = usize;

#[derive(Debug, Clone, Copy)]
pub(super) struct OrderRef {
    pub(super) side: Side,
    pub(super) price: FixedPointArithmetic,
    pub(super) node_id: NodeId,
}

impl OrderRef {
    pub(super) fn new(side: Side, price: FixedPointArithmetic, node_id: NodeId) -> Self {
        Self {
            side,
            price,
            node_id,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Node {
    pub(super) order: OrderEvent,
    pub(super) prev: Option<NodeId>,
    pub(super) next: Option<NodeId>,
}

#[derive(Debug, Clone, Default)]
pub struct PriceLevel {
    pub(super) head: Option<NodeId>,
    pub(super) tail: Option<NodeId>,
    pub(super) len: usize,
}

impl PriceLevel {
    fn head_node_id(&self) -> Option<NodeId> {
        self.head
    }
}

impl OrderBook {
    pub(super) fn node(&self, node_id: NodeId) -> &Node {
        self.nodes[node_id]
            .as_ref()
            .expect("order node missing from arena")
    }

    pub(super) fn node_mut(&mut self, node_id: NodeId) -> &mut Node {
        self.nodes[node_id]
            .as_mut()
            .expect("order node missing from arena")
    }

    pub(super) fn alloc_node(&mut self, order: OrderEvent) -> NodeId {
        let node = Node {
            order,
            prev: None,
            next: None,
        };

        if let Some(node_id) = self.free_nodes.pop() {
            self.nodes[node_id] = Some(node);
            node_id
        } else {
            self.nodes.push(Some(node));
            self.nodes.len() - 1
        }
    }

    pub(super) fn head_node_id(&self, side: Side, price: FixedPointArithmetic) -> Option<NodeId> {
        let price_idx = Self::price_to_index(price)?;
        let levels = match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        };
        levels
            .get(price_idx)
            .and_then(|opt| opt.as_ref())
            .and_then(PriceLevel::head_node_id)
    }

    pub(super) fn collect_level_orders(&self, level: &PriceLevel) -> Vec<OrderEvent> {
        let mut orders = Vec::with_capacity(level.len);
        let mut current = level.head;
        while let Some(node_id) = current {
            let node = self.node(node_id);
            orders.push(node.order);
            current = node.next;
        }
        orders
    }

    fn append_order(
        &mut self,
        side: Side,
        price: FixedPointArithmetic,
        order: OrderEvent,
    ) -> Option<NodeId> {
        let price_idx = match Self::price_to_index(price) {
            Some(i) => i,
            None => {
                tracing::warn!("Price {:?} out of range for Vec indexing", price);
                return None;
            }
        };
        let node_id = self.alloc_node(order);

        let levels = match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };
        let is_new_level = levels[price_idx].is_none();

        let prev_tail = {
            let level = levels[price_idx].get_or_insert_with(PriceLevel::default);
            let prev_tail = level.tail;
            if level.head.is_none() {
                level.head = Some(node_id);
            }
            level.tail = Some(node_id);
            level.len += 1;
            prev_tail
        };

        if let Some(prev_id) = prev_tail {
            self.node_mut(prev_id).next = Some(node_id);
            self.node_mut(node_id).prev = Some(prev_id);
        }

        if is_new_level {
            self.push_price_level(side, price);
        }

        Some(node_id)
    }

    fn unlink_node(
        &mut self,
        side: Side,
        price: FixedPointArithmetic,
        node_id: NodeId,
    ) -> Option<OrderEvent> {
        let price_idx = match Self::price_to_index(price) {
            Some(i) => i,
            None => return None,
        };

        let (order, remove_level) = {
            let node = self.nodes.get_mut(node_id)?.take()?;
            let prev = node.prev;
            let next = node.next;

            if let Some(prev_id) = prev {
                self.node_mut(prev_id).next = next;
            }

            if let Some(next_id) = next {
                self.node_mut(next_id).prev = prev;
            }

            let remove_level = {
                let levels = match side {
                    Side::Buy => &mut self.bids,
                    Side::Sell => &mut self.asks,
                };
                let level = levels[price_idx]
                    .as_mut()
                    .expect("price level missing for node");
                if level.head == Some(node_id) {
                    level.head = next;
                }
                if level.tail == Some(node_id) {
                    level.tail = prev;
                }
                level.len -= 1;
                level.len == 0
            };

            (node.order, remove_level)
        };

        if remove_level {
            let levels = match side {
                Side::Buy => &mut self.bids,
                Side::Sell => &mut self.asks,
            };
            levels[price_idx] = None;
            self.prune_price_heap(side);
        }

        self.free_nodes.push(node_id);
        Some(order)
    }

    pub(super) fn add_resting_order(&mut self, order: OrderEvent) {
        let Some(node_id) = self.append_order(order.side, order.price, order) else {
            return;
        };
        self.order_map.insert(
            order.cl_ord_id,
            OrderRef::new(order.side, order.price, node_id),
        );
        tracing::debug!(
            "[{}][{}][{}] Added order with ID: {}, side: {:?}, price: {}, node_id: {} to order map",
            market_name(),
            order.symbol,
            order.cl_ord_id,
            order.cl_ord_id,
            order.side,
            order.price,
            node_id
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
                self.unlink_node(order_ref.side, order_ref.price, order_ref.node_id)
            {
                let mut cancel_ack = order;
                cancel_ack.side = cancelled_order.side;
                cancel_ack.price = cancelled_order.price;
                cancel_ack.quantity = cancelled_order.quantity;

                tracing::debug!(
                    "[{}][{}][{}] Cancelled order with ID: {}, side: {:?}, price: {}, node_id: {}",
                    market_name(),
                    order.symbol,
                    order.cl_ord_id,
                    orig_cl_ord_id,
                    order_ref.side,
                    order_ref.price,
                    order_ref.node_id
                );

                if self.order_map.remove(&orig_cl_ord_id).is_none() {
                    tracing::error!(
                        "[{}][{}][{}] Failed to remove order with ID: {} from order map after cancellation, order not found",
                        market_name(),
                        order.symbol,
                        order.cl_ord_id,
                        orig_cl_ord_id
                    );
                }

                return (
                    cancel_ack,
                    self.build_order_result(OrderStatus::Cancelled, None),
                );
            }

            tracing::error!(
                "[{}][{}][{}] Failed to cancel order with ID: {}, side: {:?}, price: {}, node_id: {}, order not found in queue",
                market_name(),
                order.symbol,
                order.cl_ord_id,
                orig_cl_ord_id,
                order_ref.side,
                order_ref.price,
                order_ref.node_id
            );
        }

        tracing::error!(
            "[{}][{}][{}] Failed to cancel order with ID: {}, original client order ID: {}, order not found in order book",
            market_name(),
            order.symbol,
            order.cl_ord_id,
            order.cl_ord_id,
            orig_cl_ord_id
        );
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
                let best_bid_id = match self.head_node_id(Side::Buy, best_bid_price) {
                    Some(node_id) => node_id,
                    None => break,
                };

                let maker_qty_before = self.node(best_bid_id).order.quantity;
                let trade_quantity = remaining_quantity.min(maker_qty_before);
                self.node_mut(best_bid_id).order.quantity -= trade_quantity;
                remaining_quantity -= trade_quantity;

                let best_bid = self.node(best_bid_id).order;
                if let Err(_) = trades.get_or_insert_with(Trades::default).add_trade(Trade {
                    price: best_bid.price,
                    cl_ord_id: best_bid.cl_ord_id,
                    sender_id: best_bid.sender_id,
                    target_id: best_bid.target_id,
                    quantity: trade_quantity,
                    id: self.generate_trade_id(),
                    order_qty: maker_qty_before,
                    leaves_qty: best_bid.quantity,
                    ..Default::default()
                }) {
                    tracing::error!(
                        "[{}][{}][{}] Maximum number of trades reached for this order, some trades may not be recorded in the OrderResult",
                        market_name(),
                        order.symbol,
                        order.cl_ord_id
                    );
                }

                if best_bid.quantity == FixedPointArithmetic::ZERO {
                    self.unlink_node(Side::Buy, best_bid_price, best_bid_id);
                    self.order_map.remove(&best_bid.cl_ord_id);
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
                let best_ask_id = match self.head_node_id(Side::Sell, best_ask_price) {
                    Some(node_id) => node_id,
                    None => break,
                };

                let maker_qty_before = self.node(best_ask_id).order.quantity;
                let trade_quantity = remaining_quantity.min(maker_qty_before);
                self.node_mut(best_ask_id).order.quantity -= trade_quantity;
                remaining_quantity -= trade_quantity;

                let best_ask = self.node(best_ask_id).order;
                if let Err(_) = trades.get_or_insert_with(Trades::default).add_trade(Trade {
                    price: best_ask.price,
                    cl_ord_id: best_ask.cl_ord_id,
                    sender_id: best_ask.sender_id,
                    target_id: best_ask.target_id,
                    quantity: trade_quantity,
                    id: self.generate_trade_id(),
                    order_qty: maker_qty_before,
                    leaves_qty: best_ask.quantity,
                    ..Default::default()
                }) {
                    tracing::error!(
                        "[{}][{}][{}] Maximum number of trades reached for this order, some trades may not be recorded in the OrderResult",
                        market_name(),
                        order.symbol,
                        order.cl_ord_id
                    );
                }

                if best_ask.quantity == FixedPointArithmetic::ZERO {
                    self.unlink_node(Side::Sell, best_ask_price, best_ask_id);
                    self.order_map.remove(&best_ask.cl_ord_id);
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
        let level = self.bids.get(idx)?.as_ref()?;
        let node_id = level.head_node_id()?;
        Some(&self.node(node_id).order)
    }

    pub fn get_best_ask(&self) -> Option<&OrderEvent> {
        let price = self.best_price(Side::Sell)?;
        let idx = Self::price_to_index(price)?;
        let level = self.asks.get(idx)?.as_ref()?;
        let node_id = level.head_node_id()?;
        Some(&self.node(node_id).order)
    }
}
