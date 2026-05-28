# Financial Market Simulator

This project is a financial market simulator implemented in Rust. It consists of several crates that work together to simulate a financial market, including an order book, a matching engine, and a market data feed.

For now, the simulator runs on a personal computer and is accessible from internet -> www.marketsim.site


## Project Status

- Active Rust-based market simulator for order entry, matching, execution reporting, and market data distribution.
- Currently runs two separate market processes: NASDAQ and NYSE.
- Supports FIX connectivity, WebSocket/web access, PostgreSQL persistence, and UDP multicast distribution.
- Player Service (gRPC microservice on port 50052) handles all authentication and player state
- Cryptographic token generation using OsRng
- Trade execution with FIFO portfolio lot management
- Visitor counting across markets
- Admin commands: reset tokens, reset market state, reset FIX sequences
- Single gRPC connection pool with HTTP/2 multiplexing for all player service communication

## Features

### Connectivity

- FIX protocol support for order entry and execution reports.
- UDP multicast for market data distribution and snapshot.
- Web interface for monitoring and interaction.

### Persistence

- PostgreSQL database for order events, trades, and pending orders.
- Idempotency key management for reliable order processing and replay.

### Authentication & Player State

- Player service with gRPC API for authentication, portfolio management, and trade execution.
- Cryptographic token generation for secure authentication.
- Visitor counting and session tracking.

### Monitoring & Metrics

- Prometheus metrics endpoint for performance and operational monitoring.
- Metrics include login attempts, order events, trades, latency histograms, and more.
- WebSocket latency and connection metrics.

### Order population

- Fetch live price for a symbol (e.g., AAPL) from a public API (e.g., Alpha Vantage).
- Populate the order book with synthetic orders around the live price to create a realistic market environment.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLIENT LAYER                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  FIX Clients                Browser (Web / WebSocket)           │
│       |                              |                          │
│       |                              |                          │
│       |  TCP:5000 (market runtime)   |  HTTP:9860 (gateway)     │
│       |                              |                          │
│       +-----────────────┬────────────┤                          │
│                         |            |                          │
└─────────────────────────┼────────────┼──────────────────────────┘
                          v            v
┌──────────────────────────────────────────────────────────────────┐
│        GATEWAY + MARKET WEB LAYER (Docker services)              │
│                                                                  │
│  Gateway (port 9860):                                            │
│  ├─ POST /api/login (JWT auth via players-service gRPC)          │
│  └─ Routes browser to market UIs (NASDAQ/NYSE)                   │
│                                                                  │
│  Market Web (19870 NASDAQ / 19885 NYSE):                         │
│  └─ WebSocket /ws?token=X&username=alice&market=...              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │         gRPC PlayerClient (Connection Pool)                │  │
│  │  ╔════════════════════════════════════════════════════╗    │  │
│  │  ║ Single TCP/HTTP2 multiplexed connection            ║    │  │
│  │  ║ Handles: login, player state, trades, admin cmds   ║    │  │
│  │  ╚════════════════════════════════════════════════════╝    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                         │                                        │
│                         │ gRPC (HTTP/2)                          │
│                         v                                        │
│                                                                  │
│  TCP Server (Port 5000, market runtime):                         │
│  ├─ Accepts FIX clients                                          │
│  └─ Routes to FIX Inbound Engine                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                          │
           gRPC           │  TCP (FIX)
    ┌──────────────┐      │
    │              │      │
    v              v      v
┌─────────────────────────────────────────────────────────────────┐
│          PLAYER SERVICE (crates/web/players)                    │
│                  (Port 50053 - gRPC)                            │
│                                                                 │
│  Core Responsibilities:                                         │
│  ├─ User authentication & token generation (cryptographic)      │
│  ├─ Player portfolio & balance management                       │
│  ├─ Trade execution & lot tracking (FIFO)                       │
│  ├─ Visitor counting & session tracking                         │
│  └─ Admin commands (reset tokens, reset market, reset seq)      │
│                                                                 │
│  Storage:                                                       │
│  └─ PostgreSQL: players, portfolio_lots, visit_counts           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                   ORDER PROCESSING PIPELINE                      │
│                                                                  │
│  tcp_to_fix (tokio TCP)                                          │
│       │                                                          │
│       v                                                          │
│  ┌──────────────────────────────────────────────────────┐        │
│  │ FIX Inbound Engine (crates/protocol/FIX)             │        │
│  │ - Session handling, message parsing                  │        │
│  │ - FIX sequence tracking                              │        │
│  └──────────────────────────────────────────────────────┘        │
│       │ fix_to_ob (custom SPSC)                                  │
│       v                                                          │
│  ┌──────────────────────────────────────────────────────┐        │
│  │ Order Book Engine (crates/order-book)                │        │
│  │ - Matching & execution logic                         │        │
│  │ - Pending order tracking                             │        │
│  └──────────────────────────────────────────────────────┘        │
│       │                                                          │
│       ├─ ob_to_db ────────────────> DB Engine / PostgreSQL       │
│       ├─ ob_to_md ────────────────> Market Feed (UDP multicast)  │
│       ├─ ob_to_snapshot ─────────> Snapshot Engine (UDP)         │
│       │                                                          │
│       │ ob_to_er                                                 │
│       v                                                          │
│  ┌──────────────────────────────────────────────────────┐        │
│  │ Exec Report Engine (crates/execution-report)         │        │
│  │ - Builds execution reports                           │        │
│  │ - Routes to players-service & FIX clients            │        │
│  └──────────────────────────────────────────────────────┘        │
│       │ er_to_fix (custom SPSC)                                  │
│       v                                                          │
│  ┌──────────────────────────────────────────────────────┐        │
│  │ FIX Outbound Engine (crates/protocol/FIX)            │        │
│  │ - FIX response formatting & sending                  │        │
│  └──────────────────────────────────────────────────────┘        │
│       │                                                          │
│       └─> TCP Server → FIX Clients                               │
│       └─> Market Web Layer → WebSocket clients                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

ADMIN / CONTROL FLOW (gRPC from Gateway / Market Web)
┌─────────────────────────────────────────────────────────────────┐
│ Player Service (gRPC)                                           │
│ ├─ reset_all_tokens() ─────────→ Reset all player balances      │
│ ├─ reset_market_state() ──────→ Clear pending orders & state    │
│ ├─ reset_seq() ────────────────→ Reset FIX sequence per player  │
│ └─ get_player_state() ────────→ Query player state & portfolio  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Technical choices and discussion about the architecture and design of the simulator can be found here [Architecture and Design](./papers/architecture.md).


## Crates

| Crate | What it does | Docs |
|---|---|---|
| `order-book` | Maintains the order book and matching logic (add/remove/match orders). | [Order Book](crates/order-book/README.md) |
| `fix-protocol` | Implements FIX parsing/session handling for inbound and outbound trading messages. | [FIX Protocol](crates/protocol/FIX/README.md) |
| `execution-report` | Builds execution reports from order events/results for client responses and analysis. | [Execution Report](crates/execution-report/README.md) |
| `server` | TCP entrypoint that receives FIX traffic and routes requests/responses through the engines. | [Server](crates/server/README.md) |
| `proxy` | Bridges market/snapshot UDP multicast feeds to WebSocket clients via Axum. | [Proxy](crates/proxy/README.md) |
| `logging` | Project-wide logging/observability for order processing and market events. | [Logging](crates/logging/README.md) |
| `types` | Shared domain types (orders, trades, market data, etc.) used across crates. | [Types](crates/types/README.md) |
| `utils` | Shared utility helpers (timestamps, fixed-point arithmetic, traits/functions). | [Utils](crates/utils/README.md) |
| `memory` | In-memory components for low-latency order book/matching workflows. | [Memory](crates/memory/README.md) |
| `web` | Web interface layer (WebSocket/API) for interacting with the simulator. | [Web Client](crates/web/README.md) |
| `db` | PostgreSQL persistence for order events/results, trades, and pending orders. | [Database](crates/db/README.md) |

## Technical stack

| Component | Technical stack |
|---|---|
| Gateway / Market Web Backend | Rust, **Axum**, **Tokio**, `tower-http`, WebSocket (`tokio-tungstenite`), `reqwest`, `sqlx`, `tonic` |
| Player Service (`crates/web/players`) | Rust, **Tokio**, **gRPC** (`tonic`/`prost`), `sqlx` (PostgreSQL), `argon2`, `jsonwebtoken` (JWT) |
| FIX Engine (`crates/protocol/FIX`) | Rust, custom FIX parser/engine, `tokio`, `crossbeam`, custom `spsc` queue |
| Order Book (`crates/order-book`) | Rust, custom matching engine, `crossbeam-channel`, `arc-swap`, custom `spsc` queue |
| Execution Report Engine | Rust, custom execution-report crate, `crossbeam-channel`, custom `spsc` queue |
| Database Layer (`crates/db`) | PostgreSQL, `sqlx`, `tokio`, `serde_json` |
| gRPC Control (`crates/grpc`) | Rust, **gRPC** (`tonic`/`prost`), `tokio`, `sqlx` |
| Market Feed / Snapshot / Proxy | Rust, UDP/multicast path, `crossbeam-channel`, custom `spsc`, `bytemuck` |
| Observability | Prometheus endpoint (`/metrics`), `prometheus-client`, `tracing` / `tracing-subscriber` |
| Deployment | Docker, Docker Compose (`deployment/docker-compose.yml`) |

## Quick Start

Use Docker Compose from the `market-simulator` directory (compose file is in `deployment/`):

Warning: Make sure you have nightly Rust installed and set as default before running the build script, as it may use features not available in stable.

```bash
# 1) Build release binaries used by Docker images
./build-release.sh

# 2) Build and start all services
docker-compose -f deployment/docker-compose.yml build
docker-compose -f deployment/docker-compose.yml up -d

# 3) Check status/logs
docker-compose -f deployment/docker-compose.yml ps
docker-compose -f deployment/docker-compose.yml logs -f
```

> **Warning**
> For the gateway, use **only one** config at a time:
> - `crates/config/gateway/docker.local.json` (local/docker-compose setup)
> - `crates/config/gateway/docker.json` (non-local/deployment setup)
>
> Do not mix both in the same run.

Quick access:

- Gateway: http://localhost:9860
- NASDAQ web: http://localhost:19870
- NYSE web: http://localhost:19885

Stop services:

```bash
docker-compose -f deployment/docker-compose.yml down
```

The detailed setup is documented below in the simulator runtime section.

## Dockerfile and Compose setup:

Docker artifacts are under `deployment/`:

| File | Purpose |
|---|---|
| `deployment/docker-compose.yml` | Orchestrates all services (`postgres`, `players-service`, `gateway`, `market-nasdaq`, `market-nyse`). |
| `deployment/Dockerfile.gateway` | Runtime image containing both `gateway` and `market-simulator` binaries. |
| `deployment/Dockerfile.players` | Runtime image for the players gRPC service (`players-server`). |
| `deployment/Dockerfile` | Generic runtime image for `market-simulator` binary (single-binary use). |

Important notes:

1. Build binaries first: `./build-release.sh` (required before Docker build).
2. Use compose with explicit file path: `docker-compose -f deployment/docker-compose.yml ...`.
3. Gateway command should use only one config at a time: `crates/config/gateway/docker.local.json` **or** `crates/config/gateway/docker.json`.

## Ressources

- [Architecture and Design](./papers/architecture.md)
- [Market Simulator Design Notes](./papers/market-simulator.md)
- [FIX Parser Notes](./papers/fix-parser.md)
- [Idempotency](./papers/idempotency.md)
- [Metrics and Monitoring](./papers/metrics.md)
- [File Structure](./papers/files-structure.md)


## Contributing

Contributions are welcome.

Suggested workflow:

1. Open an issue to discuss a bug, improvement, or feature.
2. Keep changes focused and scoped to a single concern.
3. Update documentation when behavior, configuration, or architecture changes.
4. Run the relevant tests and benchmarks before submitting a pull request.

Areas that are especially useful for contributions:

- Rebuild the frontend client with native frameworks (e.g. React/Vite) instead of vanilla JS/HTML.
- additional order types and FIX coverage
- recovery and replay support
- monitoring, metrics, and observability
- performance optimization and benchmark coverage
- market data distribution and multicast tooling

## License

This project is licensed under the MIT License.

See [LICENSE](LICENSE) for the full text.

## Support / Contact

For bug reports, feature requests, and operational questions, please use the repository issue tracker.

When reporting a problem, include:

- the market you are running (`NASDAQ` or `NYSE`)
- the client type (`FIX`, web, or gRPC)
- relevant logs or error messages
- configuration details that may affect networking, multicast, or database setup

## Roadmap

- Create a private network so anyone can receive multicast market data updates and connect to the FIX port without exposing the server to the internet.
- Implement the replayer based on log files to allow for backtesting and analysis of market data.
- Add more command [Cancel, Replace] and order types [Stop, StopLimit] to the order book and matching engine.
- Add more instruments and support for multiple symbols in the order book and matching engine.
- Improve recovery workflows with snapshots + incremental logs.
- Expand market data tooling and multicast consumers.
