# Metrics and Prometheus

This document lists the metrics exposed by the market simulator and explains how to deploy and connect Prometheus.

## Metrics endpoint

Each market exposes Prometheus metrics at:

- `http://localhost:19870/metrics` (NASDAQ)
- `http://localhost:19885/metrics` (NYSE)

## Exported metrics

| Metric | Type | Description |
|---|---|---|
| `login_attempts_total` | counter | Total login attempts. |
| `login_success_total` | counter | Successful logins. |
| `login_failure_total` | counter | Failed login attempts. |
| `order_events_total` | counter | Total order events received. |
| `trades_total` | counter | Total executed trades. |
| `cancel_orders_total` | counter | Total cancel requests submitted. |
| `login_latency_ms` | histogram | Login latency in milliseconds. |
| `order_latency_ms` | histogram | Order submission latency in milliseconds. |
| `execution_latency_ms` | histogram | Execution/trade latency in milliseconds. |
| `order_book_events_total` | counter | Order-book events processed by engine. |
| `order_book_event_to_fanout_latency_ms` | histogram | Latency from order-book dequeue to fanout completion (ms). |
| `execution_report_events_total` | counter | Execution-report events processed. |
| `execution_report_event_to_fanout_latency_ms` | histogram | Latency from execution-report dequeue to fanout completion (ms). |
| `order_db_writes_total` | counter | Order events written to DB. |
| `order_db_write_latency_ms` | histogram | DB write latency for order events (ms). |
| `fix_requests_total` | counter | FIX requests processed. |
| `fix_responses_total` | counter | FIX responses delivered. |
| `fix_response_dropped_total` | counter | FIX responses dropped because client channel was full. |
| `fix_request_to_response_latency_ms` | histogram | FIX request-to-response latency (ms). |
| `player_api_calls_total` | counter | Backend -> player-service API calls. |
| `player_api_errors_total` | counter | Failed backend -> player-service API calls. |
| `player_api_latency_ms` | histogram | Backend -> player-service API latency (ms). |
| `ui_order_round_trip_latency_ms` | histogram | UI click-to-first-response latency (ms). |
| `websocket_fanout_to_browser_latency_us` | histogram | Fanout-to-browser latency (us). |
| `websocket_fanout_order_book_levels` | gauge | Last observed order-book levels during fanout. |
| `websocket_lagged_events_total` | counter | WebSocket events dropped due to lagging clients. |
| `websocket_send_latency_us` | histogram | WebSocket send latency (us). |
| `websocket_player_state_send_latency_us` | histogram | Player-state send latency over WebSocket (us). |
| `websocket_connections` | gauge | Active WebSocket connections. |
| `total_visitors_ever` | counter | Total WebSocket visitors ever connected. |

## Deploy Prometheus

### 1. Start the simulator

From `market-simulator/`:

```bash
./build-release.sh
docker-compose -f deployment/docker-compose.yml up -d
```

### 2. Verify metrics are reachable

```bash
curl http://localhost:19870/metrics
curl http://localhost:19885/metrics
```

### 3. Run Prometheus

Use either `prometheus.yml` or `monitoring/prometheus.yml` (both define NASDAQ/NYSE scrape jobs on `/metrics`).

#### Option A: Prometheus on host (recommended with current config)

Run Prometheus with config file `monitoring/prometheus.yml`:

```bash
prometheus --config.file=monitoring/prometheus.yml
```

#### Option B: Prometheus in Docker

If Prometheus runs in Docker, update targets from `localhost` to `host.docker.internal`:

```yaml
targets: ["host.docker.internal:19870"]
targets: ["host.docker.internal:19885"]
```

Then run:

```bash
docker run --rm -p 9090:9090 ^
  -v "%cd%\monitoring\prometheus.yml:/etc/prometheus/prometheus.yml" ^
  prom/prometheus
```

## Connect to Prometheus

1. Open `http://localhost:9090`
2. Go to **Status -> Targets** and confirm `market-nasdaq` and `market-nyse` are `UP`
3. Run queries, for example:
   - `rate(order_events_total[1m])`
   - `rate(fix_requests_total[1m])`
   - `histogram_quantile(0.99, sum(rate(order_latency_ms_bucket[5m])) by (le))`
