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

