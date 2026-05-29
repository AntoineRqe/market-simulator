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
    let mut next_order_id = OrderId::from_ascii("DELETE-ORDER-00001");
    let mut next_cancel_id = OrderId::from_ascii("DELETE-CANCEL-0001");
    let mut inserted_ids = Vec::with_capacity(iters as usize);

    for i in 0..iters {
        let order = common::limit_order(
            next_order_id,
            Side::Buy,
            123_456_000 - ((i % 500) as i64),
            1_000_000,
        );
        inserted_ids.push(next_order_id);
        next_order_id.increment();
        let result = book.process_order(order).1;
        debug_assert_eq!(result.status, OrderStatus::Unmatched);
    }

    let start = Instant::now();
    for orig_id in inserted_ids {
        let cancel = common::cancel_order(next_cancel_id, orig_id, Side::Buy);
        next_cancel_id.increment();
        let result = book.process_order(cancel).1;
        debug_assert_eq!(result.status, OrderStatus::Cancelled);
        black_box(result);
    }

    common::print_summary("order_deletion", start, iters);
}
