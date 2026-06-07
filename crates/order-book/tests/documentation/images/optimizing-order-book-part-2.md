# How to improve performance of the order book part 2

In the previous part, we implemented the Order Book by using `BTreeMap` to store the orders at each price level. This implementation is straightforward and works correctly, but it may not be the most efficient way to manage the order book, especially when we have a large number of orders. We are going to optimize the order book by using a more efficient data structure for managing the orders at each price level.

## Array pre allocation

Our first optimization is to pre-allocate an array of orders for each price level instead of using a `BTreeMap` which avoid the overhead of dynamic memory allocation and deallocation that comes with it. To do that, we set the maximum price levels at 1000, set decimal precision at 2. So we can pre-allocate an array of orders for each price level. We use a `Vec<Option<PriceLevel>>` to store the orders at each price level.

To access the orders at a specific price level, we can calculate the index in the array based on the price and the decimal precision. For example, if the price is 100.00 and the decimal precision is 2, we can calculate the index as follows:

```rust
let price = 100.00;
let decimal_precision = 2;
let index = (price * 10f64.powi(decimal_precision)).round() as usize;
```

This way, we can access the orders at the specific price level in constant time O(1) instead of logarithmic time O(log n) with a `BTreeMap`. We run the performance tests again.

### Performance results

| Metric | Part 1 After | New test | Δ % (New vs Part 1 After) |
|---|---:|---:|---:|
| Create latency p50 (ns) | 1,092 | 952 | -12.82% |
| Create latency p99 (ns) | 3,467 | 3,337 | -3.79% |
| Create latency p999 (ns) | 10,767 | 10,359 | -3.79% |
| Delete latency p50 (ns) | 1,182 | 962 | -18.61% |
| Delete latency p99 (ns) | 3,407 | 3,227 | -5.28% |
| Delete latency p999 (ns) | 8,239 | 7,515 | -8.79% |
| Delete+Depth latency p50 (ns) | 4,927,487 | 1,474,559 | -70.08% |
| Delete+Depth latency p99 (ns) | 35,782,655 | 1,908,735 | -94.67% |
| Delete+Depth latency p999 (ns) | 38,731,775 | 2,445,311 | -93.69% |
| Throughput (M msg/s) | 2.549 | 2.528 | -0.82% |

The results show a significant improvement in latency for both order creation and deletion, especially when we also retrieve the depth of the order book after deletion. The throughput remains relatively unchanged, which indicates that the optimization has not negatively impacted the overall performance of the order book.

However, the `Delete+Depth` latency is still quite high, especially compared to the `Create` and `Delete` latencies. Let's look the function for deleting and retrieving depth to see if we can optimize it further.

```rust
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
```

To delete an order, we need to do a linear search through the orders at the specific price level to find the order with the matching `cl_ord_id`. Linear search has a time complexity of O(n). A solution could be to maintain a hash map of `cl_ord_id` to the index of the order in the array for each price level. This way, we can access the order directly in constant time O(1) without having to do a linear search. But deletion modify the order array, so we need to update the hash map accordingly.

In the next part, we will implement a new data structure which aim to perform deletion in constant time O(1).

## Double linked list

Instead of using `VecDeque` to store the orders at each price level, we can use a double linked list. A double linked list allows us to easily add and remove orders from the list. It could look like this:

```rust
pub struct PriceLevel {
    pub(super) head: Option<NodeId>,
    pub(super) tail: Option<NodeId>,
    pub(super) len: usize,
}
```

The `NodeId` is a unique identifier for each order in the list. 
The Node structure could look like this:

```rust
#[derive(Debug, Clone, Copy)]
pub(super) struct Node {
    pub(super) order: OrderEvent,
    pub(super) prev: Option<NodeId>,
    pub(super) next: Option<NodeId>,
}
```

The `Node` are stored stored in a separate structure, which allows us to easily add and remove orders from the list without having to shift elements in an array. Each Node contain a copy of the order event, and the `prev` and `next` fields are used to link the nodes together in a double linked list.

To delete an order, we retrieve the `NodeId` from the hash map using the `cl_ord_id`, then we can easily unlink the node from the list by updating the `prev` and `next` pointers of the neighboring nodes. This way, we can perform deletion in constant time O(1) without having to do a linear search through the orders at the price level.

After implementing the double linked list, we run the performance tests again to see the improvement in latency for order deletion.

```
┌────────────────────────────────────────────────────┐
│            Order Book Benchmark Summary            │
├──────────────────────────────────┬─────────────────┤
│  Create Latency  n=5550000       │  p50   1011 ns  │
│                                  │  p99   5751 ns  │
│                                  │  p999  9815 ns  │
├──────────────────────────────────┼─────────────────┤
│  Delete Latency  n=3270000       │  p50   1052 ns  │
│                                  │  p99   3205 ns  │
│                                  │  p999  7243 ns  │
├──────────────────────────────────┼─────────────────┤
│  Delete+Depth  n=5550000         │  p50   1001 ns  │
│                                  │  p99   3195 ns  │
│                                  │  p999  7735 ns  │
├──────────────────────────────────┼─────────────────┤
│  Delete+SamePriceDepth  n=6550000│  p50    511 ns  │
│                                  │  p99   2695 ns  │
│                                  │  p999  6343 ns  │
├──────────────────────────────────┼─────────────────┤
│  Throughput                      │  2.672 M msg/s  │
│    total msgs                    │  30600000       │
│    total time                    │  11.451 s       │
└────────────────────────────────────────────────────┘
```

The results show a significant improvement in latency for order deletion, especially when we also retrieve the depth of the order book after deletion. The throughput also shows a slight improvement, which indicates that the optimization has positively impacted the overall performance of the order book.

### Flamegraph hotspots

I run the flamegraph for the `Delete+Depth` scenario to see where the time is spent.

The same-price-depth delete profile still spends most of its time in engine bookkeeping around the cancel path:

| Block | Representative frames | Time spent (approx.) |
|---|---|---:|
| Order processing | `order_book::book::book_linked_list::<impl OrderBook>::process_buy_limit_order` | ~7.3% |
| Queue maintenance | `alloc::vec::Vec::swap_remove` | ~6.0% |
| Order map insertion | `ahash::hash_map::AHashMap::insert` | ~4.8% |
| Timestamp capture | `std::sys::pal::unix::time::Timespec::now` | ~3.3% |
| Result construction | `order_book::book::OrderBook::build_order_result` | ~2.7% |
| Cancel handling | `order_book::book::book_linked_list::<impl OrderBook>::process_cancel_order` | ~2.1% |
| Order map removal | `ahash::hash_map::AHashMap::remove` | ~1.4% |

Note that I changed the Hash function to `ahash` which is faster than the default `SipHash` used by Rust's standard library. But why do I still need to do hash map insertion and removal for each order deletion? 

This is because we need to maintain a mapping of `cl_ord_id` to `NodeId` in order to perform deletion in constant time O(1). This HashMap maintenance still represents a significant portion of the time spent in the delete path, especially when we also retrieve the depth of the order book after deletion.
