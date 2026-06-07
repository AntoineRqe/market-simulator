#[path = "common.rs"]
mod common;

use std::collections::HashMap;
use std::hint::black_box;
use std::time::Instant;

use types::OrderStatus;
use types::Side;
use types::macros::OrderId;

const BOOK_DEPTH: usize = 10_000;
const SAME_PRICE: i64 = 123_456_000;

fn main() {
    let iters = common::scenario_iters();
    let mut book = common::new_order_book();
    book.reserve_orders(BOOK_DEPTH + (iters as usize));

    let mut next_order_id = OrderId::from_ascii("SAMEPRICE-ORDER-00001");
    let mut next_cancel_id = OrderId::from_ascii("SAMEPRICE-CANCEL-0001");

    let mut live_order_ids = Vec::with_capacity(BOOK_DEPTH);
    let mut live_order_indices = HashMap::with_capacity(BOOK_DEPTH * 2);
    for _ in 0..BOOK_DEPTH {
        let current_order_id = next_order_id;
        next_order_id.increment();
        live_order_indices.insert(current_order_id, live_order_ids.len());
        live_order_ids.push(current_order_id);

        let order = common::limit_order(current_order_id, Side::Buy, SAME_PRICE, 1_000_000);
        let result = book.process_order(order).1;
        debug_assert_eq!(result.status, OrderStatus::New);
    }

    let start = Instant::now();
    for _ in 0..iters {
        let index = live_order_ids.len() / 2;
        let orig_id = live_order_ids.swap_remove(index);
        live_order_indices.remove(&orig_id);
        if index < live_order_ids.len() {
            let moved_order_id = live_order_ids[index];
            live_order_indices.insert(moved_order_id, index);
        }

        let cancel = common::cancel_order(next_cancel_id, orig_id, Side::Buy);
        next_cancel_id.increment();
        let cancel_result = book.process_order(cancel).1;
        debug_assert_eq!(cancel_result.status, OrderStatus::Cancelled);
        black_box(cancel_result);

        let replacement_id = next_order_id;
        next_order_id.increment();
        live_order_indices.insert(replacement_id, live_order_ids.len());
        live_order_ids.push(replacement_id);

        let replacement = common::limit_order(replacement_id, Side::Buy, SAME_PRICE, 1_000_000);
        let replacement_result = book.process_order(replacement).1;
        debug_assert_eq!(replacement_result.status, OrderStatus::New);
        black_box(replacement_result);
    }

    common::print_summary("order_deletion_same_price_depth", start, iters);
}
