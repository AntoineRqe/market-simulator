# How to improve performance of the order book

In this paper, we discuss various techniques and optimizations to improve the performance of an order book implementation. We focus on reducing latency and maximizing throughput while maintaining the integrity and correctness of the order book.

At first, we discuss how we are going to test and benchmark the performance of our order book implementation.

## Performance Testing and Benchmarking

In order to mesure the performance of the order book, we will need two kind of tests: raw tests and criterion based tests.

### Raw performance tests

The idea is the repeat the same operation (e.g., order creation, order deletion), get the overall time taken and divide it by the number of iterations to get the average time taken per operation. 

The point of raw performance tests is to be able to use profiling tools (e.g., `perf`, `cargo-flamegraph`) to analyze the performance of specific scenarios without the overhead of Criterion. So it is important to have a harness-free way to run these tests.

### Criterion-based benchmarks

Criterion is a powerful benchmarking library for Rust that provides statistical analysis and reporting of benchmark results. It allows us to define benchmarks for specific scenarios (e.g., order creation, order deletion) and compare the performance of different implementations or optimizations.

We also use `histogram` to analyze the distribution of latencies and identify any outliers or performance bottlenecks. This will be a much more refined way to analyze the performance of our order book implementation and compare different optimizations.

Now that the testing and benchmarking strategies are defined, we can discuss the various optimizations we can implement to improve the performance of our order book implementation.

## Order Book with Double End Queue

The first version of our order book implementation uses a double end queue (e.g., `VecDeque`) to store orders at each price level. This allows for efficient insertion and deletion of orders while maintaining the order of arrival (FIFO) at each price level.

The Order Book is implemented as a `BTreeMap` of price levels, where each price level contains a `VecDeque` of orders. This allows for efficient lookup of price levels and efficient management of orders at each price level.

```rust
pub struct PriceLevel {
    pub(super) orders: VecDeque<OrderEvent>,
}

#[derive(Debug)]
pub struct OrderBook {
    pub bids: BTreeMap<FixedPointArithmetic, PriceLevel>,
    pub asks: BTreeMap<FixedPointArithmetic, PriceLevel>,
}
```

For creation, we simply push the new order to the back of the `VecDeque` at the corresponding price level. For deletion, we need to search for the order in the `VecDeque` and remove it. This can be done efficiently using the `iter().position()` method to find the index of the order and then using `remove()` to delete it from the `VecDeque`.

We run the `perf` for order creation and deletion scenarios to analyze the performance of this implementation.

| Metric | Creation | Deletion |
|---|---:|---:|
| cache-references | 109,092,767 | 131,856,169 |
| cache-misses | 22,705,677 (20.81%) | 30,289,009 (22.97%) |
| branches | 573,077,907 | 758,266,837 |
| branch-misses | 27,971,826 (4.88%) | 28,827,473 (3.80%) |
| cycles | 4,987,357,097 | 7,590,693,120 |
| instructions | 3,583,503,662 (0.72 IPC) | 5,308,808,004 (0.70 IPC) |
| stalled cycles per instruction | 0.30 | 0.24 |
| stalled-cycles-frontend | 1,081,172,341 (21.68%) | 1,259,393,837 (16.59%) |
| L1-dcache-loads | 1,323,123,458 | 1,941,781,358 |
| L1-dcache-load-misses | 73,367,044 (5.54%) | 86,156,205 (4.44%) |
| L1-icache-loads | 419,263,412 | 436,058,480 |
| L1-icache-load-misses | 392,035 (0.09%) | 424,227 (0.10%) |
| time elapsed | 1.088 ± 0.153 s | 1.669 ± 0.289 s |
| real | 5.46 s | 8.37 s |
| user | 3.51 s | 6.44 s |
| sys | 1.94 s | 1.93 s |

At first, we are going to focus on the time spent in kernel space (sys) and user space (user).

### Kernel space (sys)

The time spent in kernel space is mostly due to memory management and system calls. In our case, the main system call that we are making is the allocation and deallocation of memory for the `VecDeque` when we create and delete orders. In order to analyse kernel space time, we can use `perf` to analyze the system calls and memory management operations that are being performed during the order creation and deletion scenarios.

```bash
perf stat -r 10 -e task-clock,context-switches,cpu-migrations,page-faults,minor-faults,major-faults   "$BIN" 5000000
order_creation: iterations=5000000, elapsed=3.96426208s, ns/op=792, ops/s=1261269
order_creation: iterations=5000000, elapsed=2.546365943s, ns/op=509, ops/s=1963583
order_creation: iterations=5000000, elapsed=2.529803275s, ns/op=505, ops/s=1976438
order_creation: iterations=5000000, elapsed=2.499576837s, ns/op=499, ops/s=2000339
order_creation: iterations=5000000, elapsed=2.526242949s, ns/op=505, ops/s=1979224
order_creation: iterations=5000000, elapsed=2.511877219s, ns/op=502, ops/s=1990543
order_creation: iterations=5000000, elapsed=2.534117765s, ns/op=506, ops/s=1973073
order_creation: iterations=5000000, elapsed=2.520889579s, ns/op=504, ops/s=1983427
order_creation: iterations=5000000, elapsed=2.541098077s, ns/op=508, ops/s=1967653
order_creation: iterations=5000000, elapsed=2.526180043s, ns/op=505, ops/s=1979273

 Performance counter stats for 'target/profiling/deps/perf_order_creation-0b5f2902b78c8904 5000000' (10 runs):

     2,746,874,135      task-clock                       #    1.000 CPUs utilized               ( +-  5.21% )
                32      context-switches                 #   11.650 /sec                        ( +-  8.27% )
                 4      cpu-migrations                   #    1.456 /sec                        ( +- 28.67% )
           376,605      page-faults                      #  137.103 K/sec                       ( +-  0.00% )
           376,605      minor-faults                     #  137.103 K/sec                       ( +-  0.00% )
                 0      major-faults                     #    0.000 /sec                      

             2.748 +- 0.143 seconds time elapsed  ( +-  5.21% )
```

This output shows that the time spent in kernel space is mostly due to page faults, which are caused by the allocation and deallocation of memory for the `VecDeque`. This indicates that we can optimize the performance of our order book implementation by reducing the number of memory allocations and deallocations that we perform during order creation and deletion. We will keep in mind to remove as much allocations as possible in the next version of our order book implementation.

### User space (user)

In order to analyze the time spent in user space, we can use the profiling tool `perf` + `cargo-flamegraph` to generate flamegraphs for the order creation and deletion scenarios. This will allow us to visualize the call stack and identify any performance bottlenecks in our code.

```bash
sudo -E env CARGO_TARGET_DIR="$PWD/target-flame-vecdeque"   cargo flamegraph -p order-book   --profile profiling   --test perf_order_creation   --output "$PWD/flamegraph-vecdeque.svg"   -- 1000000
```

![Flamegraph for order creation with VecDeque](./images/vecdeque-no-optim.png)

The repartition of the time spent in the userspace is as followed:

| Function | Time spent |
|---|---:|
| `SystemTime::now` via `Trades::default` | ~ 19% |
| `HashMap::insert` via `Order_Map` | ~ 19% |
| Kernel page-fault  | ~ 15% |
| VecDeque operation | ~ 7,5% |

First item is an interesting one: when an order arrives, we create a `OrderResult` struct that contains a `Trades` struct, which contains a `timestamp` field that is initialized with the current system time using `SystemTime::now()`. This means that every time we create an order, we are calling `SystemTime::now()`, which can be a costly operation. We can optimize this by using a monotonic clock or a timestamp generator that is updated periodically instead of calling `SystemTime::now()` for every order creation.

```rust
pub struct OrderResult {
    pub internal_order_id: u64, // Internal order ID assigned by the engine, can be used for tracking and debugging
    pub trades: Trades<4>,      // Fixed-size array for trades, adjust size as needed
    pub status: OrderStatus,
    pub timestamp_ms: u64, // Timestamp in milliseconds since epoch, added for potential future use in time-priority sorting
}
```

The correct implementation should be to generate trades only if a trade occurs, and not to generate a trade for every order creation. This means that we should only call `SystemTime::now()` when a trade occurs, and not for every order creation. Let's implement that and see how it affects the performance of our order book implementation.

![Flamegraph for order creation with VecDeque, no automatic trades](./images/vecdeque-no-trades.png)

| Block | Representative frames | Time spent (approx.) |
|---|---|---:|
| Order map insertion / writes | `hashbrown::HashMap::insert`, `RawTable::insert_*`, `Bucket::write`, `memcpy` | ~23–25% |
| Kernel memory fault handling | `asm_exc_page_fault`, `do_user_addr_fault`, `handle_mm_fault`, `do_anonymous_page` | ~17–21% |
| VecDeque append path | `add_resting_order`, `append_order`, `VecDeque::push_back` | ~8–10% |
| Book teardown / free / unmap | `drop_in_place<OrderBook>`, `dealloc`, `munmap` | ~4.5–5.5% |
| Other / unresolved symbols | `[unknown]`, `[[vdso]]` | ~18–27% |

We can see that the time spent in `SystemTime::now()` has been removed, and the time spent in the order map insertion and kernel memory fault handling has increased.
Looking at this flamegraph, the remaining time is mostly spent in the order map insertion and kernel memory fault handling. We could keep optimizing for memory management but let's first check how the performance of the order deletion scenario is affected by this optimization.

## Benchmarking with Criterion

We run Criterion benchmarks for order creation and deletion scenarios to analyze the performance of our order book implementation before and after optimization. The three scenarios we are going to benchmark are:

- Order creation: measure the latency of creating orders in the order book, **one by one**.
- Order deletion: measure the latency of deleting orders from the order book, **one by one**.
- Order deletion with depth: populate the order book with a large number of orders, then measure the latency of deleting orders for various price levels and depths in the order book. Deletion are made **one by one**
- Throughput: measure the overall throughput of the order book by simulating a high volume of order creation and deletion operations and measuring the number of operations processed per second.

The counter start when the order is sent to the order book FIFO and stop when Response is received by the outbound FIFO. This means that the latency metrics include the time taken for the order to be processed by the order book engine, as well as the time taken for the response to be sent back to the producer thread. 

The Producer and Consumer threads are pinned to separate CPU cores to minimize contention, but the assigned CPU are not isolated so other process can infer on the results. The benchmarks are run on a machine with an AMD Ryzen 9 5950X CPU (16 cores, 32 threads) and 64 GB of RAM.

Each benchmark is run for a total of 10 iterations, and the results are averaged to get the final latency and throughput metrics. The latency metrics are reported in nanoseconds (ns) for the p50, p99, and p999 percentiles, while the throughput is reported in millions of messages per second (M msg/s).

### Comparison of performance metrics before and after optimization

| Metric | Before | After | Δ % (After vs Before) |
|---|---:|---:|---:|
| Create latency p50 (ns) | 1092 | 1092 | 0.00% |
| Create latency p99 (ns) | 3377 | 3467 | +2.66% |
| Create latency p999 (ns) | 12159 | 10767 | -11.45% |
| Delete latency p50 (ns) | 1202 | 1182 | -1.66% |
| Delete latency p99 (ns) | 3327 | 3407 | +2.40% |
| Delete latency p999 (ns) | 8015 | 8239 | +2.79% |
| Delete+Depth latency p50 (ns) | 5,386,239 | 4,927,487 | -8.52% |
| Delete+Depth latency p99 (ns) | 39,157,759 | 35,782,655 | -8.62% |
| Delete+Depth latency p999 (ns) | 45,121,535 | 38,731,775 | -14.16% |
| Throughput (M msg/s) | 2.387 | 2.549 | **+6.79%** |

The latency metrics are not significantly affected by the optimization, because we only send one other at a time.

However, the throughput has improved by approximately 6.79%, mostly due to reduction in `OrderResult` creation we had optimized.

The latency for delete with depth scenario is really bad compared to single delete scenario. Our intuition tells us that deleting orders with depth is expensive because we have to look for the correct order in the `VecDeque`. One way to confirm this is to use `perf record` on both delete and delete with depth scenarios and perform a differential analysis.

```bash
sudo perf diff delete.data depth.data
# Event 'cycles:P'
#
# Baseline  Delta Abs  Shared Object                                    Symbol                                                                                                                                                       >
# ........  .........  ...............................................  .............................................................................................................................................................>
#
              +33.98%  perf_order_deletion_with_depth-5017784401422df1  [.] core::hash::BuildHasher::hash_one
               +9.58%  perf_order_deletion_with_depth-5017784401422df1  [.] order_book::book::OrderBook::process_order
               +7.93%  perf_order_deletion_with_depth-5017784401422df1  [.] perf_order_deletion_with_depth::main
               +5.52%  perf_order_deletion_with_depth-5017784401422df1  [.] <std::hash::random::DefaultHasher as core::hash::Hasher>::write
     3.37%     -3.27%  libc.so.6                                        [.] clock_gettime@@GLIBC_2.17
     4.50%     +1.94%  [kernel.kallsyms]                                [k] clear_page_erms
               +1.79%  perf_order_deletion_with_depth-5017784401422df1  [.] order_book::book::OrderBook::add_resting_order
     1.86%     +1.77%  libc.so.6                                        [.] __memmove_avx512_unaligned_erms
               +1.65%  perf_order_deletion_with_depth-5017784401422df1  [.] alloc::collections::btree::map::BTreeMap<K,V,A>::remove
               +1.40%  perf_order_deletion_with_depth-5017784401422df1  [.] order_book::book::OrderBook::process_buy_limit_order
               +1.27%  perf_order_deletion_with_depth-5017784401422df1  [.] hashbrown::map::HashMap<K,V,S,A>::insert
               +0.89%  perf_order_deletion_with_depth-5017784401422df1  [.] hashbrown::map::HashMap<K,V,S,A>::remove
               +0.77%  perf_order_deletion_with_depth-5017784401422df1  [.] alloc::collections::btree::node::Handle<alloc::collections::btree::node::NodeRef<alloc::collections::btree::node::marker::Mut,K,V,alloc::collections::btr>
     0.33%     +0.63%  [kernel.kallsyms]                                [k] zap_present_ptes.constprop.0
     0.19%     +0.56%  [kernel.kallsyms]                                [k] srso_alias_safe_ret
```


The important results from this differential analysis are:

- The `core::hash::BuildHasher::hash_one` ( +*33,98%** ) function is significantly more expensive in the delete with depth scenario, which suggests that the hash map operations (insertion and deletion) are more costly when we have to look for the correct order in the `VecDeque`.
- The `order_book::book::OrderBook::process_order` ( +*9,58%** ) function is also more expensive
- The `DefaultHasher::write` ( +*5,52%** ) function is more expensive, which suggests that the hashing of the order ID is more costly when we have to look for the correct order in the `VecDeque`.

This results clearly leads us to the next optimization phase: 

Replace the HashMap by an other data structure to prevent hash operations during order deletion. We will discuss this optimization in the next part of this paper.
