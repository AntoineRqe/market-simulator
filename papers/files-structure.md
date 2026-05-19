# Market Simulator workspace tree

This document describes the folder structure for the **`market-simulator`** project only.

## Tree (folders only)

```text
market-simulator
├── .github
│   └── hooks
├── .vscode
├── benches
├── crates
│   ├── config
│   │   ├── gateway
│   │   ├── markets
│   │   └── src
│   ├── db
│   │   └── src
│   ├── execution-report
│   │   ├── benches
│   │   └── src
│   ├── grpc
│   │   ├── proto
│   │   └── src
│   ├── logging
│   │   └── src
│   ├── market-feed
│   │   └── src
│   ├── memory
│   │   └── src
│   ├── order-book
│   │   ├── bench
│   │   └── src
│   ├── protocol
│   │   └── FIX
│   │       ├── benches
│   │       ├── examples
│   │       └── src
│   ├── proxy
│   │   └── src
│   ├── snapshot
│   │   └── src
│   ├── types
│   │   └── src
│   ├── utils
│   │   └── src
│   └── web
│       ├── backend
│       │   └── src
│       ├── frontend
│       │   └── src
│       └── players
│           ├── proto
│           └── src
│               └── players
├── deployment
├── monitoring
├── papers
│   └── assets
│       └── images
├── src
│   └── bin
└── tools
    └── images
```

## Folder descriptions

| Folder | Description |
|---|---|
| `.github` | Repository automation and GitHub-specific configuration. |
| `.github/hooks` | Hook/automation support files used by GitHub workflows or tooling. |
| `.vscode` | Local VS Code project settings. |
| `benches` | Top-level benchmark entry points for the workspace. |
| `crates` | Workspace crates (modular services/libraries of the simulator). |
| `crates/config` | Config crate for loading/validating application configuration. |
| `crates/config/gateway` | Gateway-specific JSON configurations by environment. |
| `crates/config/markets` | Per-market configuration files (for exchanges like NASDAQ/NYSE). |
| `crates/config/src` | Source code for the config crate. |
| `crates/db` | Database integration crate (PostgreSQL persistence). |
| `crates/db/src` | DB crate implementation. |
| `crates/execution-report` | Execution report generation/routing crate. |
| `crates/execution-report/benches` | Benchmarks for execution-report performance. |
| `crates/execution-report/src` | Source code for execution-report logic. |
| `crates/grpc` | Shared gRPC protocol/service crate used across components. |
| `crates/grpc/proto` | Protobuf definitions for gRPC APIs. |
| `crates/grpc/src` | Generated/manual Rust bindings and gRPC helpers. |
| `crates/logging` | Logging setup and shared logging utilities. |
| `crates/logging/src` | Logging crate source code. |
| `crates/market-feed` | Market data feed engine (distribution/publishing side). |
| `crates/market-feed/src` | Market-feed implementation. |
| `crates/memory` | In-memory data structures/utilities used by runtime services. |
| `crates/memory/src` | Memory crate source code. |
| `crates/order-book` | Matching engine and order-book core logic. |
| `crates/order-book/bench` | Local benchmarks for order-book internals. |
| `crates/order-book/src` | Order-book and matching implementation. |
| `crates/protocol` | Protocol implementations used by the simulator. |
| `crates/protocol/FIX` | FIX protocol parser/session/engine crate. |
| `crates/protocol/FIX/benches` | FIX parser/engine benchmarks. |
| `crates/protocol/FIX/examples` | Example/profiling binaries for FIX flows. |
| `crates/protocol/FIX/src` | FIX protocol source code. |
| `crates/proxy` | Proxy server crate for routing/network-facing flow control. |
| `crates/proxy/src` | Proxy crate implementation. |
| `crates/snapshot` | Snapshot engine crate for market state snapshots. |
| `crates/snapshot/src` | Snapshot encoding/types/engine implementation. |
| `crates/types` | Shared domain types (orders, trades, metrics, constants, macros). |
| `crates/types/src` | Core shared type definitions. |
| `crates/utils` | Cross-cutting helper functions/traits/utilities. |
| `crates/utils/src` | Utils crate implementation. |
| `crates/web` | Web-facing components and services. |
| `crates/web/backend` | HTTP/WebSocket backend for clients and gateway integration. |
| `crates/web/backend/src` | Backend service implementation. |
| `crates/web/frontend` | Frontend web crate/assets for browser UI. |
| `crates/web/frontend/src` | Frontend Rust source code. |
| `crates/web/players` | Player/auth gRPC microservice crate. |
| `crates/web/players/proto` | Protobuf contract for player service APIs. |
| `crates/web/players/src` | Player service main implementation. |
| `crates/web/players/src/players` | Player-domain modules (auth, portfolio, token, services). |
| `deployment` | Deployment assets (Dockerfiles, compose, nginx, deployment guides). |
| `monitoring` | Monitoring configuration (e.g., Prometheus config). |
| `papers` | Architecture/design/technical documentation. |
| `papers/assets` | Static assets used by technical papers. |
| `papers/assets/images` | Images/diagrams/flamegraphs for papers. |
| `src` | Root binary entrypoint sources for workspace-level apps. |
| `src/bin` | Additional executable binaries (e.g., gateway binary). |
| `tools` | Utility scripts for local ops, testing, and diagnostics. |
| `tools/images` | Images/screenshots used by tool documentation. |