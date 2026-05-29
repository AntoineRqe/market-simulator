use std::collections::{BTreeMap, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};
use types::{FixedPointArithmetic, OrderEvent, OrderResult, OrderStatus, OrderType, Side, Trades, macros::OrderId};

#[cfg(all(feature = "PriceLevelVecDeque", feature = "PriceLevelFifo"))]
compile_error!(
    "Features `PriceLevelVecDeque` and `PriceLevelFifo` are mutually exclusive; enable only one"
);
#[cfg(not(any(feature = "PriceLevelVecDeque", feature = "PriceLevelFifo")))]
compile_error!("Either `PriceLevelVecDeque` or `PriceLevelFifo` must be enabled");

#[cfg(feature = "PriceLevelVecDeque")]
#[path = "book-vecdeque.rs"]
mod book_vecdeque;
#[cfg(feature = "PriceLevelFifo")]
#[path = "book-linked-list.rs"]
mod book_linked_list;

#[cfg(feature = "PriceLevelVecDeque")]
pub use self::book_vecdeque::PriceLevel;
#[cfg(feature = "PriceLevelFifo")]
pub use self::book_linked_list::PriceLevel;

#[cfg(feature = "PriceLevelVecDeque")]
use self::book_vecdeque::OrderRef;
#[cfg(feature = "PriceLevelFifo")]
use self::book_linked_list::{Node, NodeId, OrderRef};

/// Represents the order book, maintaining separate heaps for bids and asks.
/// Bids are stored in a max-heap (higher prices have priority), while asks are stored in a min-heap (lower prices have priority).
/// The order book processes incoming orders, matches them against existing orders, and updates the order book accordingly.
/// - `bids`: A binary heap containing buy orders, sorted by price in descending order.
/// - `asks`: A binary heap containing sell orders, sorted by price in ascending order (using `Reverse` to achieve min-heap behavior).
/// - `trade_id_counter`: A counter used to generate unique trade IDs for matched orders.
#[derive(Debug)]
pub struct OrderBook {
    /// Bids are stored in a BTreeMap where the key is the price and the value is a linked FIFO level.
    pub bids: BTreeMap<FixedPointArithmetic, PriceLevel>,
    /// Asks are stored in a BTreeMap where the key is the price and the value is a linked FIFO level.
    pub asks: BTreeMap<FixedPointArithmetic, PriceLevel>,
    /// Internal counter for generating unique order IDs for incoming orders. This is used to assign an internal order ID to each order as it is processed, which can be useful for tracking and referencing orders within the order book.
    pub(crate) internal_id_counter: u64,
    /// Counter for generating unique trade IDs for matched orders. Each time a trade is executed, a new trade ID is generated using this counter to ensure that each trade can be uniquely identified and tracked.
    pub(crate) trade_id_counter: u64,
    #[cfg(feature = "PriceLevelFifo")]
    nodes: Vec<Option<Node>>,
    #[cfg(feature = "PriceLevelFifo")]
    free_nodes: Vec<NodeId>,
    /// Map to track orders by their ID for efficient cancellation and modification.
    order_map: HashMap<OrderId, OrderRef>,
    /// The symbol for this order book.
    pub(crate) symbol: String,
}

impl std::fmt::Display for OrderBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Ask")?;
        for ask in self.asks.iter() {
            write!(f, "\n{}", ask.0)?;
        }
        write!(f, "\nBid")?;
        for bid in self.bids.iter().rev() {
            write!(f, "\n{}", bid.0)?;
        }
        Ok(())
    }
}
impl OrderBook {
    pub fn new(symbol: &str) -> Self {
        OrderBook {
            // Arbitrary initial capacity for the heaps to avoid frequent resizing; can be adjusted based on expected order volume.
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            internal_id_counter: 1, // Start at 1; 0 is reserved as the sentinel "no ID" value
            trade_id_counter: 1,    // Start at 1; 0 is reserved as the sentinel "no ID" value
            #[cfg(feature = "PriceLevelFifo")]
            nodes: Vec::new(),
            #[cfg(feature = "PriceLevelFifo")]
            free_nodes: Vec::new(),
            order_map: HashMap::new(),  // Initialize the order map
            symbol: symbol.to_string(), // Set the symbol for this order book
        }
    }

    pub fn reserve_orders(&mut self, additional: usize) {
        self.order_map.reserve(additional);
    }

    fn generate_internal_order_id(&mut self) -> u64 {
        let id = self.internal_id_counter;
        self.internal_id_counter += 1;
        id
    }

    fn generate_trade_id(&mut self) -> u64 {
        let id = self.trade_id_counter;
        self.trade_id_counter += 1;
        id
    }

    fn levels(&self, side: Side) -> &BTreeMap<FixedPointArithmetic, PriceLevel> {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    fn levels_mut(&mut self, side: Side) -> &mut BTreeMap<FixedPointArithmetic, PriceLevel> {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    // TODO: This function is called multiple times during order matching, we can optimize it by caching the best price for each side and only updating it when the best price level is modified.
    fn best_price(&self, side: Side) -> Option<FixedPointArithmetic> {
        match side {
            Side::Buy => self.bids.last_key_value().map(|(&price, _)| price),
            Side::Sell => self.asks.first_key_value().map(|(&price, _)| price),
        }
    }

    #[cfg(test)]
    fn price_level_orders(&self, side: Side, price: FixedPointArithmetic) -> Vec<OrderEvent> {
        self.levels(side)
            .get(&price)
            .map(|level| self.collect_level_orders(level))
            .unwrap_or_default()
    }

    /// Processes an incoming order by determining its type (limit or market) and side (buy or sell), and then calling the appropriate processing function. The function is instrumented with tracing to provide detailed logs of the order processing steps, including the order ID, side, price, and quantity.
    /// Arguments:
    /// - `order`: The incoming order to be processed, containing details such as price, quantity, side, order type, order ID, and broker ID.
    /// Returns:
    /// - An `OrderResult` containing the details of the processed order, including any trade ID and status.
    //#[instrument(level = "debug", skip(self, order), fields(order_id = order.order_id, side = ?order.side, price = order.price, quantity = order.quantity))]
    pub fn process_order(&mut self, order: OrderEvent) -> (OrderEvent, OrderResult) {
        match order.order_type {
            OrderType::LimitOrder => self.process_limit_order(order),
            OrderType::MarketOrder => self.process_market_order(order),
            OrderType::CancelOrder => self.process_cancel_order(order),
        }
    }

    /// Processes a limit order by matching it against existing orders in the order book based on its side (buy or sell). For buy limit orders, it matches against the best available asks, and for sell limit orders, it matches against the best available bids. If the order is not fully filled after matching, it is added to the appropriate side of the order book (bids for buy orders and asks for sell orders) for future matching.
    /// Arguments:
    /// - `order`: The incoming limit order to be processed, containing details such as price, quantity, side, order ID, and broker ID.
    /// Returns:
    /// - An `OrderResult` containing the details of the processed order, including any trade ID and status. The trade ID is generated if the order was partially or fully filled, and the status is determined based on the remaining quantity of the order.
    fn process_limit_order(&mut self, order: OrderEvent) -> (OrderEvent, OrderResult) {
        match order.side {
            Side::Buy => {
                let (order, result) = self.process_buy_limit_order(order);
                (order, result)
            }
            Side::Sell => {
                let (order, result) = self.process_sell_limit_order(order);
                (order, result)
            }
        }
    }

    /// Processes a market order by treating it as a limit order with an infinitely high price for buy orders or an infinitely low price for sell orders. This ensures that market orders will match with the best available prices in the order book. The function then calls the appropriate processing function for limit orders to handle the matching and execution of the market order.
    /// Arguments:
    /// - `order`: The incoming market order to be processed, containing details such as price, quantity, side, order ID, and broker ID.
    /// Returns:
    /// - An `OrderResult` containing the details of the processed order, including any trade ID and status. The trade ID is generated if the order was partially or fully filled, and the status is determined based on the remaining quantity of the order.
    fn process_market_order(&mut self, order: OrderEvent) -> (OrderEvent, OrderResult) {
        match order.side {
            Side::Buy => {
                let (order, result) = self.process_buy_market_order(order);
                (order, result)
            }
            Side::Sell => {
                let (order, result) = self.process_sell_market_order(order);
                (order, result)
            }
        }
    }

    /// Generates an `OrderResult` based on the processed order, including trade ID and status.
    /// The trade ID is generated if the order was partially or fully filled, and the status is determined based on the remaining quantity of the order.
    /// Arguments:
    /// - `order`: The order that was processed, containing details such as price, quantity, side, order ID, and broker ID.
    /// - `trades`: The trades that were executed as a result of processing the order, which may include multiple trades if the order was matched against multiple existing orders in the order book.
    /// Returns:
    /// - An `OrderResult` containing the details of the processed order, including any trade ID and status. The status is determined based on the remaining quantity of the order after processing.
    pub(super) fn build_order_result(
        &mut self,
        status: OrderStatus,
        trades: Option<Trades<4>>,
    ) -> OrderResult {
        OrderResult {
            internal_order_id: self.generate_internal_order_id(),
            trades,
            status,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        }
    }

    fn generate_order_result(
        &mut self,
        order: OrderEvent,
        trades: Option<Trades<4>>,
    ) -> (OrderEvent, OrderResult) {
        let status = match (trades.is_some(), order.quantity) {
            (false, _) => OrderStatus::Unmatched,
            (true, quantity) if quantity == FixedPointArithmetic::ZERO => OrderStatus::Filled,
            (true, _) => OrderStatus::PartiallyFilled,
        };
        let order_result = self.build_order_result(status, trades);
        (order, order_result)
    }

    fn process_buy_market_order(&mut self, mut order: OrderEvent) -> (OrderEvent, OrderResult) {
        order.price = FixedPointArithmetic::from_f64(f64::INFINITY); // Market orders are treated as having an infinitely high price to ensure they match with the best available asks
        self.process_buy_limit_order(order)
    }

    fn process_sell_market_order(&mut self, mut order: OrderEvent) -> (OrderEvent, OrderResult) {
        order.price = FixedPointArithmetic::from_f64(f64::NEG_INFINITY); // Market orders are treated as having an infinitely low price to ensure they match with the best available bids
        self.process_sell_limit_order(order)
    }

    /// Calculates the spread of the order book, which is the difference between the best ask price and the best bid price. If either the best bid or best ask is not available, it returns `None`.
    /// Returns:
    /// - An `Option<FixedPointArithmetic>` containing the spread if both best bid and best ask are available, or `None` if either is missing.
    pub fn get_spread(&self) -> Option<FixedPointArithmetic> {
        match (self.get_best_bid(), self.get_best_ask()) {
            (Some(best_bid), Some(best_ask)) => Some(FixedPointArithmetic::from_raw(
                best_ask.price.raw() - best_bid.price.raw(),
            )),
            _ => None,
        }
    }

    /// Dumps the current state of the order book for a given side (buy or sell) as a vector of orders. This can be useful for debugging or visualization purposes.
    /// Arguments:
    /// - `side`: The side of the order book to dump (either `Side::Buy` for bids or `Side::Sell` for asks).
    /// Returns:
    /// - A `Vec<OrderEvent>` containing the orders for the specified side of the order book. For bids, it returns the orders directly from the `bids` heap, and for asks, it extracts the inner `OrderEvent` from the `Reverse` wrapper in the `asks` heap.
    pub fn dump_order_book(&self, side: Side, depth: usize) -> Vec<OrderEvent> {
        match side {
            Side::Buy => self
                .bids
                .iter()
                .rev()
                .flat_map(|(_price, level)| self.collect_level_orders(level))
                .take(depth)
                .collect(),
            Side::Sell => self
                .asks
                .iter()
                .flat_map(|(_price, level)| self.collect_level_orders(level))
                .take(depth)
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use types::macros::{EntityId, OrderId, SymbolId};

    const SYMBOL_STR: &str = "TEST";
    const SYMBOL_ID: SymbolId = SymbolId::from_ascii(SYMBOL_STR);
    const SENDER: EntityId = EntityId::from_ascii("SENDER0000000000000");
    const TARGET: EntityId = EntityId::from_ascii("TARGET0000000000000");
    const CL_ORD_ID: OrderId = OrderId::from_ascii("12345");

    #[test]
    fn test_order_book_initialization() {
        let order_book = OrderBook::new(SYMBOL_STR);
        assert!(order_book.get_best_bid().is_none());
        assert!(order_book.get_best_ask().is_none());
        assert!(order_book.get_spread().is_none());
    }

    #[test]
    fn test_cancel_order() {
        let mut order_book = OrderBook::new(SYMBOL_STR);
        let order = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0), // 100.0 with 8 decimal places
            quantity: FixedPointArithmetic::from_f64(10.0), // 10.0 with 8 decimal places
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            orig_cl_ord_id: None,
            cl_ord_id: CL_ORD_ID,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order, result) = order_book.process_order(order);
        assert_eq!(result.status, OrderStatus::New);
        assert!(order.price == FixedPointArithmetic::from_f64(100.0));
        assert!(order.quantity == FixedPointArithmetic::from_f64(10.0));

        let cancel_order = OrderEvent {
            price: FixedPointArithmetic::ZERO, // Price is not relevant for cancel orders
            quantity: FixedPointArithmetic::ZERO, // Quantity is not relevant for cancel orders
            side: Side::Buy, // Side is not relevant for cancel orders, but we can set it to match the original order
            order_type: OrderType::CancelOrder,
            cl_ord_id: CL_ORD_ID, // Use the same ClOrdID to identify which order to cancel
            orig_cl_ord_id: Some(CL_ORD_ID),
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the cancel order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (cancel_order, cancel_result) = order_book.process_order(cancel_order);
        assert_eq!(cancel_result.status, OrderStatus::Cancelled);
        assert_eq!(cancel_order.price, order.price); // The cancel acknowledgment should reflect the original order's price
        assert_eq!(cancel_order.quantity, order.quantity); // The cancel acknowledgment should reflect the original order's quantity
        assert!(order_book.asks.is_empty()); // There should be no asks in the order book
        assert!(order_book.bids.is_empty()); // There should be no bids in the order book
        assert!(order_book.order_map.is_empty()); // There should be no asks in the order book

        // Testing cancellation of a sell order
        let order = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0), // 100.0 with 8 decimal places
            quantity: FixedPointArithmetic::from_f64(10.0), // 10.0 with 8 decimal places
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order, result) = order_book.process_order(order);
        assert_eq!(result.status, OrderStatus::New);
        assert!(order.price == FixedPointArithmetic::from_f64(100.0));
        assert!(order.quantity == FixedPointArithmetic::from_f64(10.0));

        let cancel_order = OrderEvent {
            price: FixedPointArithmetic::ZERO, // Price is not relevant for cancel orders
            quantity: FixedPointArithmetic::ZERO, // Quantity is not relevant for cancel orders
            side: Side::Sell, // Side is not relevant for cancel orders, but we can set it to match the original order
            order_type: OrderType::CancelOrder,
            cl_ord_id: CL_ORD_ID, // Use the same ClOrdID to identify which order to cancel
            orig_cl_ord_id: Some(CL_ORD_ID),
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the cancel order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (cancel_order, cancel_result) = order_book.process_order(cancel_order);
        assert_eq!(cancel_result.status, OrderStatus::Cancelled);
        assert!(cancel_order.price == order.price); // The cancel acknowledgment should reflect the original order's price
        assert!(cancel_order.quantity == order.quantity); // The cancel acknowledgment should reflect the original order's quantity
        assert_eq!(order_book.get_best_ask(), None); // The best ask should be removed after cancellation
        assert!(order_book.order_map.is_empty()); // There should be no asks in the order book
    }

    #[test]
    fn test_single_limit_order() {
        let mut order_book = OrderBook::new(SYMBOL_STR);
        let order = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0), // 100.0 with 8 decimal places
            quantity: FixedPointArithmetic::from_f64(10.0), // 10.0 with 8 decimal places
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order, result) = order_book.process_order(order);

        assert_eq!(order.price, FixedPointArithmetic::from_f64(100.0));
        assert_eq!(order.quantity, FixedPointArithmetic::from_f64(10.0));
        assert_eq!(result.trades_len(), 0); // No trades executed
        assert_eq!(result.traded_qty(), FixedPointArithmetic::ZERO); // Total quantity should be zero since no trades were executed
        assert_eq!(result.avg_trade_price(), FixedPointArithmetic::ZERO); // Average price should be zero since no trades were executed
        assert_eq!(result.status, OrderStatus::New);
        assert_eq!(
            order_book.get_best_bid().unwrap().price,
            FixedPointArithmetic::from_f64(100.0)
        ); // Best bid should be the price of the order
        assert_eq!(
            order_book.get_best_bid().unwrap().quantity,
            FixedPointArithmetic::from_f64(10.0)
        ); // Best bid quantity should be the quantity of the order
    }

    #[test]
    fn test_trade_with_same_price() {
        let mut order_book = OrderBook::new(SYMBOL_STR);
        let order1 = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0), // 100.0 with 8 decimal places
            quantity: FixedPointArithmetic::from_f64(10.0), // 10.0 with 8 decimal places
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order2 = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order1, result1) = order_book.process_order(order1);
        let (order2, result2) = order_book.process_order(order2);

        assert_eq!(order1.price, FixedPointArithmetic::from_f64(100.0));
        assert_eq!(order1.quantity, FixedPointArithmetic::from_f64(10.0));
        assert_eq!(result1.trades_len(), 0); // No trades executed for the first order
        assert_eq!(result1.status, OrderStatus::New);

        assert_eq!(order2.price, FixedPointArithmetic::from_f64(100.0));
        assert_eq!(order2.quantity, FixedPointArithmetic::from_f64(5.0)); // The second order should be completely filled, so the remaining quantity should be 0
        assert_eq!(result2.trades_len(), 1); // One trade executed for the second order
        assert_eq!(
            result2.trades.unwrap()[0].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // 5 units filled
        assert_eq!(
            result2.trades.unwrap()[0].price,
            FixedPointArithmetic::from_f64(100.0)
        ); // Trade price should be 100.0
        assert_eq!(
            result2.traded_qty(),
            FixedPointArithmetic::from_f64(5.0)
        ); // Total quantity should be 5.0
        assert_eq!(
            result2.avg_trade_price(),
            FixedPointArithmetic::from_f64(100.0)
        ); // Average price should be 100.0
        assert_eq!(result2.status, OrderStatus::New);
    }

    #[test]
    fn test_limit_orders_single_trade() {
        logging::init_tracing("order_book");

        let mut order_book = OrderBook::new(SYMBOL_STR);
        let order1 = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0), // 100.0 with 8 decimal places
            quantity: FixedPointArithmetic::from_f64(10.0), // 10.0 with 8 decimal places
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order2 = OrderEvent {
            price: FixedPointArithmetic::from_f64(99.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order3 = OrderEvent {
            price: FixedPointArithmetic::from_f64(98.0),
            quantity: FixedPointArithmetic::from_f64(10.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,    // Set the symbol for the order
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order1, result1) = order_book.process_order(order1);
        let (order2, result2) = order_book.process_order(order2);
        let (order3, result3) = order_book.process_order(order3);

        // The first order should not be matched immediately, as there are no existing orders in the order book, so it should be added to the bids.
        assert!(order1.price == FixedPointArithmetic::from_f64(100.0));
        assert!(order1.quantity == FixedPointArithmetic::from_f64(10.0));
        assert_eq!(result1.trades_len(), 0); // No trades executed,
        assert_eq!(result1.traded_qty(), FixedPointArithmetic::ZERO); // Total quantity should be zero since no trades were executed
        assert_eq!(result1.avg_trade_price(), FixedPointArithmetic::ZERO); // Average price should be zero since no trades were executed
        assert_eq!(result1.status, OrderStatus::New);

        // The second order should be completely filled (5 units filled, 0 units remaining).
        assert_eq!(order2.price, FixedPointArithmetic::from_f64(99.0));
        assert_eq!(order2.quantity, FixedPointArithmetic::from_f64(5.0));
        assert_eq!(result2.trades_len(), 1); // 5 units * 99.0 price
        assert_eq!(result2.trades.unwrap()[0].id, 1); // Trade ID should be 1 for the first trade (counter starts at 1)
        assert_eq!(
            result2.trades.unwrap()[0].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // 5 units filled
        assert_eq!(
            result2.trades.unwrap()[0].price,
            FixedPointArithmetic::from_f64(100.0)
        ); // 100.0
        assert_eq!(
            result2.avg_trade_price(),
            FixedPointArithmetic::from_f64(100.0)
        ); // Average price should be 100.0
        assert!(result2.traded_qty() == FixedPointArithmetic::from_f64(5.0)); // Total quantity should be 5.0
        assert_eq!(result2.status, OrderStatus::New);
        assert_eq!(
            result2.avg_trade_price(),
            FixedPointArithmetic::from_f64(100.0)
        ); // Average price should be 100.0
        assert_eq!(
            result2.traded_qty(),
            FixedPointArithmetic::from_f64(5.0)
        ); // Total quantity should be 5.0

        // The third order should not be matched immediately, as there are no existing orders in the order book, so it should be added to the asks.
        assert_eq!(order3.price, FixedPointArithmetic::from_f64(98.0));
        assert_eq!(order3.quantity, FixedPointArithmetic::from_f64(10.0));
        assert_eq!(result3.trades_len(), 1); // 5 units * 98.0 price
        assert_eq!(
            result3.trades.unwrap()[0].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // 5 units filled
        assert_eq!(
            result3.trades.unwrap()[0].price,
            FixedPointArithmetic::from_f64(100.0)
        ); // 5 units * 100.0 price
        assert_eq!(
            result3.avg_trade_price(),
            FixedPointArithmetic::from_f64(100.0)
        ); // Average price should be 100.0
        assert!(result3.traded_qty() == FixedPointArithmetic::from_f64(5.0)); // Total quantity should be 5.0
        assert_eq!(result3.status, OrderStatus::New);
        assert_eq!(
            result3.avg_trade_price(),
            FixedPointArithmetic::from_f64(100.0)
        ); // Average price should be 100.0
        assert_eq!(
            result3.traded_qty(),
            FixedPointArithmetic::from_f64(5.0)
        ); // Total quantity should be 5.0

        assert_eq!(order_book.bids.len(), 0); // One ask should remain in the order book
        assert_eq!(order_book.asks.len(), 1); // One ask should remain in the order book
        assert_eq!(
            order_book.asks.first_entry().unwrap().key(),
            &FixedPointArithmetic::from_f64(98.0)
        ); // The remaining ask should be the one at 98.0
        let remaining_asks =
            order_book.price_level_orders(Side::Sell, FixedPointArithmetic::from_f64(98.0));
        assert_eq!(
            remaining_asks[0].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // The remaining ask should have a quantity of 5
        assert_eq!(remaining_asks[0].cl_ord_id, CL_ORD_ID); // The remaining ask should have the same ClOrdID as the third order
        assert_eq!(remaining_asks[0].sender_id, SENDER); // The remaining ask should have the same sender ID as the third order
        assert_eq!(remaining_asks[0].target_id, TARGET); // The remaining ask should have the same target ID as the third order
        assert_eq!(remaining_asks[0].order_type, OrderType::LimitOrder); // The remaining ask should have the same order type as the third order
        // Give time for the logs to be flushed before the test ends
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    #[test]
    fn test_limit_orders_multiple_trades() {
        logging::init_tracing("order_book");

        let mut order_book = OrderBook::new(SYMBOL_STR);

        let order1 = OrderEvent {
            price: FixedPointArithmetic::from_f64(99.0),
            quantity: FixedPointArithmetic::from_f64(3.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order2 = OrderEvent {
            price: FixedPointArithmetic::from_f64(98.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order3 = OrderEvent {
            price: FixedPointArithmetic::from_f64(97.0),
            quantity: FixedPointArithmetic::from_f64(3.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order4 = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0),
            quantity: FixedPointArithmetic::from_f64(10.0),
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order1, result1) = order_book.process_order(order1);
        let (order2, result2) = order_book.process_order(order2);
        let (order3, result3) = order_book.process_order(order3);
        let (order4, result4) = order_book.process_order(order4);

        // The first order should not be matched immediately, as there are no existing orders in the order book, so it should be added to the bids.
        assert_eq!(order1.price, FixedPointArithmetic::from_f64(99.0));
        assert_eq!(order1.quantity, FixedPointArithmetic::from_f64(3.0));
        assert_eq!(result1.trades_len(), 0); // No trades executed,
        assert_eq!(result1.status, OrderStatus::New);

        // The second order should not be matched immediately, as there are no existing orders in the order book, so it should be added to the bids.
        assert_eq!(order2.price, FixedPointArithmetic::from_f64(98.0));
        assert_eq!(order2.quantity, FixedPointArithmetic::from_f64(5.0));
        assert_eq!(result2.trades_len(), 0); // No trades executed,
        assert_eq!(result2.status, OrderStatus::New);

        // The third order should not be matched immediately, as there are no existing orders in the order book, so it should be added to the bids.
        assert_eq!(order3.price, FixedPointArithmetic::from_f64(97.0));
        assert_eq!(order3.quantity, FixedPointArithmetic::from_f64(3.0));
        assert_eq!(result3.trades_len(), 0); // No trades executed,
        assert_eq!(result3.status, OrderStatus::New);

        // The fourth order should be completely filled (3 units filled at 97.0, 5 units filled at 98.0, and 2 units filled at 99.0).
        assert_eq!(order4.price, FixedPointArithmetic::from_f64(100.0));
        assert_eq!(order4.quantity, FixedPointArithmetic::from_f64(10.0));
        assert_eq!(result4.trades_len(), 3); // 3 trades executed
        assert_eq!(
            result4.trades.unwrap()[0].quantity,
            FixedPointArithmetic::from_f64(3.0)
        ); // 3 units filled
        assert_eq!(
            result4.trades.unwrap()[0].price,
            FixedPointArithmetic::from_f64(97.0)
        ); // 3 units * 97.0 price
        assert_eq!(
            result4.trades.unwrap()[1].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // 5 units filled
        assert_eq!(
            result4.trades.unwrap()[1].price,
            FixedPointArithmetic::from_f64(98.0)
        ); // 5 units * 98.0 price
        assert_eq!(
            result4.trades.unwrap()[2].quantity,
            FixedPointArithmetic::from_f64(2.0)
        ); // 2 units filled
        assert_eq!(
            result4.trades.unwrap()[2].price,
            FixedPointArithmetic::from_f64(99.0)
        ); // 2 units * 99.0 price
        assert_eq!(result4.status, OrderStatus::New);
        assert_eq!(
            result4.avg_trade_price(),
            FixedPointArithmetic::from_f64(97.9)
        ); // Average price should be (3*97 + 5*98 + 2*99) / 10 = 98.0
        assert_eq!(
            result4.traded_qty(),
            FixedPointArithmetic::from_f64(10.0)
        ); // Total quantity should be 10.0

        assert_eq!(order_book.asks.len(), 1); // One ask should remain in the order book
        assert_eq!(
            order_book.asks.first_entry().unwrap().key(),
            &FixedPointArithmetic::from_f64(99.0)
        ); // The remaining ask should be the one at 99.0
        let remaining_asks =
            order_book.price_level_orders(Side::Sell, FixedPointArithmetic::from_f64(99.0));
        assert_eq!(
            remaining_asks[0].quantity,
            FixedPointArithmetic::from_f64(1.0)
        ); // The remaining ask should have a quantity of 1
        assert_eq!(remaining_asks[0].cl_ord_id, CL_ORD_ID); // The remaining ask should have the same ClOrdID as the first order
        assert_eq!(remaining_asks[0].sender_id, SENDER); // The remaining ask should have the same sender ID as the first order
        assert_eq!(remaining_asks[0].target_id, TARGET); // The remaining ask should have the same target ID as the first order
        assert_eq!(remaining_asks[0].order_type, OrderType::LimitOrder);
        // The remaining ask should have the same order type as the first order

        assert!(order_book.bids.is_empty()); // No bids should remain in the order book

        // Give time for the logs to be flushed before the test ends
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    #[test]
    fn test_market_orders() {
        logging::init_tracing("order_book");

        let mut order_book = OrderBook::new(SYMBOL_STR);

        let order1 = OrderEvent {
            price: FixedPointArithmetic::from_f64(99.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order2 = OrderEvent {
            price: FixedPointArithmetic::from_f64(98.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order3 = OrderEvent {
            price: FixedPointArithmetic::from_f64(98.0),
            quantity: FixedPointArithmetic::from_f64(10.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order4 = OrderEvent {
            price: FixedPointArithmetic::from_f64(0.0), // Price is ignored for market orders
            quantity: FixedPointArithmetic::from_f64(12.0),
            side: Side::Buy,
            order_type: OrderType::MarketOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        let (order1, result1) = order_book.process_order(order1);
        let (order2, result2) = order_book.process_order(order2);
        let (order3, result3) = order_book.process_order(order3);
        let (order4, result4) = order_book.process_order(order4);

        // The first three orders should be added to the asks heap as they are limit sell orders.
        assert_eq!(order1.price, FixedPointArithmetic::from_f64(99.0));
        assert_eq!(order1.quantity, FixedPointArithmetic::from_f64(5.0));
        assert_eq!(result1.trades_len(), 0); // No trades executed
        assert_eq!(result1.status, OrderStatus::New);

        assert_eq!(order2.price, FixedPointArithmetic::from_f64(98.0));
        assert_eq!(order2.quantity, FixedPointArithmetic::from_f64(5.0));
        assert_eq!(result2.trades_len(), 0); // No trades executed
        assert_eq!(result2.status, OrderStatus::New);

        assert_eq!(order3.price, FixedPointArithmetic::from_f64(98.0));
        assert_eq!(order3.quantity, FixedPointArithmetic::from_f64(10.0));
        assert_eq!(result3.trades_len(), 0); // No trades executed
        assert_eq!(result3.status, OrderStatus::New);

        // The fourth order should be completely filled (5 units filled at 98.0 and 7 units filled at 99.0).
        assert_eq!(order4.price, FixedPointArithmetic::from_f64(f64::MAX)); // Price is ignored for market orders
        assert_eq!(order4.quantity, FixedPointArithmetic::from_f64(12.0));
        assert_eq!(result4.trades_len(), 2); // 2 trades executed
        assert_eq!(result4.trades.unwrap()[0].id, 1); // Trade ID should be 1 for the first trade (counter starts at 1)
        assert_eq!(
            result4.trades.unwrap()[0].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // 5 units filled
        assert_eq!(
            result4.trades.unwrap()[0].price,
            FixedPointArithmetic::from_f64(98.0)
        ); // 5 units * 98.0 price
        assert_eq!(result4.trades.unwrap()[1].id, 2); // Trade ID should be 2 for the second trade
        assert_eq!(
            result4.trades.unwrap()[1].quantity,
            FixedPointArithmetic::from_f64(7.0)
        ); // 7 units filled
        assert_eq!(
            result4.trades.unwrap()[1].price,
            FixedPointArithmetic::from_f64(98.0)
        ); // 7 units * 98.0 price
        assert_eq!(result4.status, OrderStatus::New);

        // Check the remaining orders in the order book after processing the market order
        assert_eq!(order_book.asks.len(), 2); // Two asks should remain in the order book
        assert_eq!(
            order_book.asks.first_entry().unwrap().key(),
            &FixedPointArithmetic::from_f64(98.0)
        ); // The remaining ask should be the one at 98.0
        let best_remaining_asks =
            order_book.price_level_orders(Side::Sell, FixedPointArithmetic::from_f64(98.0));
        assert_eq!(
            best_remaining_asks[0].quantity,
            FixedPointArithmetic::from_f64(3.0)
        ); // The remaining ask should have a quantity of 3.0
        assert_eq!(best_remaining_asks[0].cl_ord_id, CL_ORD_ID); // The remaining ask should have the same ClOrdID as the third order
        assert_eq!(best_remaining_asks[0].sender_id, SENDER); // The remaining ask should have the same sender ID as the third order
        assert_eq!(best_remaining_asks[0].target_id, TARGET); // The remaining ask should have the same target ID as the third order
        assert_eq!(best_remaining_asks[0].order_type, OrderType::LimitOrder); // The remaining ask should have the same order type as the third order
        assert_eq!(
            order_book.asks.iter().nth(1).unwrap().0,
            &FixedPointArithmetic::from_f64(99.0)
        ); // The second remaining ask should be the one at 99.0
        let second_remaining_asks =
            order_book.price_level_orders(Side::Sell, FixedPointArithmetic::from_f64(99.0));
        assert_eq!(
            second_remaining_asks[0].quantity,
            FixedPointArithmetic::from_f64(5.0)
        ); // The second remaining ask should have a quantity of 5.0
        assert_eq!(second_remaining_asks[0].cl_ord_id, CL_ORD_ID); // The second remaining ask should have the same ClOrdID as the first order
    }

    #[test]
    fn test_spread_calculation() {
        logging::init_tracing("order_book");
        let mut order_book = OrderBook::new(SYMBOL_STR);
        let order1 = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0),
            quantity: FixedPointArithmetic::from_f64(10.0),
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order2 = OrderEvent {
            price: FixedPointArithmetic::from_f64(102.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        order_book.process_order(order1);
        order_book.process_order(order2);

        let spread = order_book.get_spread();
        assert_eq!(spread, Some(FixedPointArithmetic::from_f64(2.0))); // Spread should be 102.0 - 100.0 = 2.0

        // Give time for the logs to be flushed before the test ends
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    #[test]
    fn test_dump_order_book() {
        logging::init_tracing("order_book");
        let mut order_book = OrderBook::new(SYMBOL_STR);
        let order1 = OrderEvent {
            price: FixedPointArithmetic::from_f64(100.0),
            quantity: FixedPointArithmetic::from_f64(10.0),
            side: Side::Buy,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };
        let order2 = OrderEvent {
            price: FixedPointArithmetic::from_f64(102.0),
            quantity: FixedPointArithmetic::from_f64(5.0),
            side: Side::Sell,
            order_type: OrderType::LimitOrder,
            cl_ord_id: CL_ORD_ID,
            orig_cl_ord_id: None,
            sender_id: SENDER,
            target_id: TARGET,
            symbol: SYMBOL_ID,
            ..Default::default() // Set the timestamp to the current time in milliseconds since epoch
        };

        order_book.process_order(order1);
        order_book.process_order(order2);

        let bids = order_book.dump_order_book(Side::Buy, 10); // Dump the top 10 levels of the bid side
        let asks = order_book.dump_order_book(Side::Sell, 10); // Dump the top 10 levels of the ask side

        assert_eq!(bids.len(), 1); // One bid should be in the order book
        assert_eq!(bids[0].price, FixedPointArithmetic::from_f64(100.0)); // The bid should have the correct price
        assert_eq!(bids[0].quantity, FixedPointArithmetic::from_f64(10.0)); // The bid should have the correct quantity
        assert_eq!(bids[0].cl_ord_id, CL_ORD_ID); // The bid should have the correct client order ID
        assert_eq!(bids[0].target_id, TARGET); // The bid should have the correct target ID
        assert_eq!(bids[0].order_type, OrderType::LimitOrder); // The bid should have the correct order type

        assert_eq!(asks.len(), 1); // One ask should be in the order book
        assert_eq!(asks[0].price, FixedPointArithmetic::from_f64(102.0)); // The ask should have the correct price
        assert_eq!(asks[0].quantity, FixedPointArithmetic::from_f64(5.0)); // The ask should have the correct quantity
        assert_eq!(asks[0].cl_ord_id, CL_ORD_ID); // The ask should have the correct client order ID
        assert_eq!(asks[0].sender_id, SENDER); // The ask should have the correct sender ID
        assert_eq!(asks[0].target_id, TARGET); // The ask should have the correct target ID
        assert_eq!(asks[0].order_type, OrderType::LimitOrder); // The ask should have the correct order type
    }
}
