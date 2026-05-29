use std::time::Instant;

use order_book::book::OrderBook;
use types::macros::{EntityId, OrderId, SymbolId};
use types::{FixedPointArithmetic, OrderEvent, OrderType, Side};

pub const DEFAULT_ITERS: u64 = 200_000;

pub fn scenario_iters() -> u64 {
    std::env::var("PERF_ITERS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| std::env::args().nth(1).and_then(|value| value.parse::<u64>().ok()))
        .unwrap_or(DEFAULT_ITERS)
}

pub fn new_order_book() -> OrderBook {
    OrderBook::new("TEST".into())
}

pub fn limit_order(order_id: OrderId, side: Side, price_raw: i64, qty_raw: i64) -> OrderEvent {
    OrderEvent {
        order_type: OrderType::LimitOrder,
        cl_ord_id: order_id,
        orig_cl_ord_id: None,
        side,
        price: FixedPointArithmetic(price_raw),
        quantity: FixedPointArithmetic(qty_raw),
        sender_id: EntityId::from_ascii("SENDER"),
        target_id: EntityId::from_ascii("TARGET"),
        symbol: SymbolId::from_ascii("TEST"),
        timestamp_ms: 0,
    }
}

pub fn cancel_order(cancel_id: OrderId, orig_id: OrderId, side: Side) -> OrderEvent {
    OrderEvent {
        order_type: OrderType::CancelOrder,
        cl_ord_id: cancel_id,
        orig_cl_ord_id: Some(orig_id),
        side,
        price: FixedPointArithmetic::ZERO,
        quantity: FixedPointArithmetic::ZERO,
        sender_id: EntityId::from_ascii("SENDER"),
        target_id: EntityId::from_ascii("TARGET"),
        symbol: SymbolId::from_ascii("TEST"),
        timestamp_ms: 0,
    }
}

pub fn print_summary(name: &str, start: Instant, iters: u64) {
    let elapsed = start.elapsed();
    let ns_per_op = elapsed.as_nanos() / iters as u128;
    let ops_per_sec = (iters as f64) / elapsed.as_secs_f64();
    println!(
        "{name}: iterations={iters}, elapsed={elapsed:?}, ns/op={ns_per_op}, ops/s={ops_per_sec:.0}"
    );
}
