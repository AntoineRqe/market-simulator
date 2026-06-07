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

This is a first step towards optimizing the order book, we will generate the flamegraph to identify the hotspots and further optimize the order book in the next part.

### Flamegraph analysis

![Flamegraph](./prealloc_vec.png)

| Block | Percentage (approx.) |
|---|---:|
| `OrderMap insert` (`HashMap::insert` + `RawTable::insert_*`) | 21.35% |
| `Memory copy` (`__memcpy_avx512_unaligned_erms`) | 18.75% |
| `Kernel page faults` (`asm_exc_page_fault` + `handle_mm_fault` chain) | 15.85% |
| `OrderMap remove` (`RawTable::remove_entry`) | 12.09% |
| `Hashing` (`DefaultHasher/SipHasher::write`) | 11.46% |
| `Anonymous page allocation` (`do_anonymous_page`) | 11.11% |

The flamgraph analysis show that the main hotspots are related to the `HashMap` operations (insertion and removal), memory copying, and kernel page faults. We removed the `HashMap` for managing the orders at each price level, but there is still `HashMap` for managing the price levels as shown in this data structure:

```rust
#[derive(Debug)]
pub struct OrderBook {
    /// Bids are stored in a Vec<Option<PriceLevel>> indexed by price (raw i64 value).
    pub bids: Vec<Option<PriceLevel>>,
    /// Asks are stored in a Vec<Option<PriceLevel>> indexed by price (raw i64 value).
    pub asks: Vec<Option<PriceLevel>>,
    /// Map to track orders by their ID for efficient cancellation and modification.
    order_map: HashMap<OrderId, OrderRef>,
}
```

Why do we still have `HashMap` for managing the price levels? If `order_map` doesn't exist, we would have to search through the orders at each price level to find the order to delete, which would be inefficient. The `order_map` allows us to quickly find the order by its ID and then access the corresponding price level and order in constant time O(1). However, each insertion and deletion in the `HashMap` involves hashing the order ID and managing the internal structure of the `HashMap`, which can lead to performance overhead, especially when we have a large number of orders.