#[path = "common.rs"]
mod common;

use std::hint::black_box;
use std::time::Instant;

use types::OrderStatus;
use types::Side;
use types::macros::OrderId;

const BOOK_DEPTH: usize = 10_000;

fn main() {
    let iters = common::scenario_iters();
    let mut book = common::new_order_book();
    let mut next_order_id = OrderId::from_ascii("DEPTH-ORDER-00001");
    let mut next_cancel_id = OrderId::from_ascii("DEPTH-CANCEL-0001");

    let mut active_ids = Vec::with_capacity(BOOK_DEPTH);
    for i in 0..BOOK_DEPTH {
        let order = common::limit_order(
            next_order_id,
            Side::Buy,
            123_456_000 - ((i as i64) * 100),
            1_000_000,
        );
        active_ids.push(next_order_id);
        next_order_id.increment();
        let result = book.process_order(order).1;
        debug_assert_eq!(result.status, OrderStatus::Unmatched);
    }

    let depth_profile = [0usize, 1, 8, 64, 512, 2048, 8192, BOOK_DEPTH - 1];
    let mut replacement_price = 100_000_000_i64;
    let start = Instant::now();

    for i in 0..iters {
        let depth = depth_profile[(i as usize) % depth_profile.len()] % active_ids.len();
        let orig_id = active_ids.swap_remove(depth);

        let cancel = common::cancel_order(next_cancel_id, orig_id, Side::Buy);
        next_cancel_id.increment();
        let cancel_result = book.process_order(cancel).1;
        debug_assert_eq!(cancel_result.status, OrderStatus::Cancelled);
        black_box(cancel_result);

        let replacement_id = next_order_id;
        next_order_id.increment();
        replacement_price -= 1;
        let replacement =
            common::limit_order(replacement_id, Side::Buy, replacement_price, 1_000_000);
        let replacement_result = book.process_order(replacement).1;
        debug_assert_eq!(replacement_result.status, OrderStatus::Unmatched);
        active_ids.push(replacement_id);
    }

    common::print_summary("order_deletion_with_depth", start, iters);
}
