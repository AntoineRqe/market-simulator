#[path = "common.rs"]
mod common;

use std::hint::black_box;
use std::time::Instant;

use types::OrderStatus;
use types::Side;
use types::macros::OrderId;

fn main() {
    let iters = common::scenario_iters();
    let mut book = common::new_order_book();
    book.reserve_orders(iters as usize);
    let mut next_order_id = OrderId::from_ascii("CREATE-ORDER-00001");

    let start = Instant::now();
    for i in 0..iters {
        let order = common::limit_order(
            next_order_id,
            Side::Buy,
            123_456_000 - ((i % 500) as i64),
            1_000_000,
        );
        next_order_id.increment();

        let result = book.process_order(order).1;
        debug_assert_eq!(result.status, OrderStatus::Unmatched);
        black_box(result);
    }

    common::print_summary("order_creation", start, iters);
}
