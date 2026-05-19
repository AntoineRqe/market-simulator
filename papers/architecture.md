# Market Simulator architecture

This document describes the architecture of the **`market-simulator`** project. It is a high-level overview of the different components and how they interact with each other.

## Architecture overview

This section provides a high-level overview of the architecture of the **`market-simulator`** project. It describes the differents components and how they interact with each other using Docker images.

```text
Clients
-------
FIX clients ----\
Browser UI ------+----> gateway:9860
Ops tools -------/

Docker Host (single machine)
Network: market-network (bridge)

                        +--------------------+
                        | gateway            |
                        | container (9860)   |
                        +--------------------+
                           |              |
                           v              v
               +---------------------+  +---------------------+
               | market-nasdaq       |  | market-nyse         |
               | (19870,50051,9891)  |  | (19885,50052,9892)  |
               +---------------------+  +---------------------+
                        | \            / |
                        |  \          /  |
                        v   v        v   v
            +---------------------+  +---------------------------+
            | players-service     |  | postgres                  |
            | container (50053)   |  | container (5432 internal) |
            +---------------------+  +---------------------------+
```

### Components

- **Clients**: The clients are the users of the market simulator. They can be FIX clients that connect to the gateway using TCP, or they can be users accessing the browser UI.
-
- **Gateway**: The gateway is the entry point for all clients. It listens for incoming connections from FIX clients and the browser UI. It routes FIX messages to the appropriate market simulator (NASDAQ or NYSE) and handles HTTP requests from the browser UI.

- **Market simulators**: The market simulators are responsible for simulating the behavior of the stock markets. They receive FIX messages from the gateway, process them, and send responses back to the gateway. They also generate market data and send it to the gateway for distribution to clients.

- **Players service**: The players service is responsible for managing player accounts, authentication, and portfolio management. It provides a gRPC API for the gateway to interact with player data and perform operations such as login, portfolio updates, and player state management.

- **PostgreSQL**: The PostgreSQL database is used to store market data, player information, and other persistent data required by the market simulator. It is accessed by both the market simulators for storing market events and by the players service for managing player data.

### Architecture decisions

I've decided to use a single Docker host with multiple containers for the different components of the market simulator. This allows for easier development and testing, as well as better resource management. The components communicate with each other using TCP and gRPC, which provides a clear separation of concerns and allows for scalability in the future if needed.

## Specific architecture

This section provides a more detailed description of the architecture of the **`market-simulator`** project.

### Gateway

The gateway is the central component that handles all incoming connections from clients (both FIX and browser) and routes them to the appropriate market simulator or player service. It listens on port 9860 for HTTP/WebSocket connections from the browser UI and on ports 19870/19885 for FIX connections from FIX clients. The gateway uses gRPC to communicate with the players service for authentication and player state management. Authentication is JWT-based: the gateway receives a signed JWT at login and validates JWT-backed access on subsequent browser/WebSocket requests. It also routes FIX messages to the market simulators and sends market data updates back to clients.

The following diagram shows how a user logs in and establishes a WebSocket connection to a market:

```
BROWSER                          WEB SERVER                      PLAYER SERVICE
   │                                  │                                 │
   │  1. POST /api/login              │                                 │
   │     {username, password}         │                                 │
   ├─────────────────────────────────>│                                 │
   │                                  │  2. gRPC: authenticate_or_register
   │                                  ├────────────────────────────────>│
   │                                  │  3. Validate credentials        │
   │                                  │     Generate signed JWT token   │
   │                                  │  4. gRPC Response               │
   │                                  │     {token, username, is_admin} │
   │                                  │<────────────────────────────────┤
   │  5. HTTP Response                │                                 │
   │     {token, username, is_admin}  │                                 │
   │<─────────────────────────────────┤                                 │
   │                                  │                                 │
   │  6. Store in sessionStorage:     │                                 │
   │     - auth_token                 │                                 │
   │     - username                   │                                 │
   │     - is_admin                   │                                 │
   │                                  │                                 │
   │  7. WebSocket: ws://market:9860/ │                                 │
   │     ws?token=X&username=alice    │                                 │
   │     &market=NASDAQ               │                                 │
   ├─────────────────────────────────>│                                 │
   │                                  │  8. gRPC: Implicit JWT token    │
   │                                  │     validation on player methods│
   │                                  ├────────────────────────────────>│
   │                                  │  9. Player state loaded         │
   │                                  │<────────────────────────────────┤
   │  10. WebSocket Connected         │                                 │
   │      Ready for orders & updates  │                                 │
   │<─────────────────────────────────┤                                 │
   │                                  │                                 │
   │  11. Place Order                 │                                 │
   │      {symbol, qty, price, side}  │                                 │
   ├─────────────────────────────────>│                                 │
   │                                  │  12. gRPC: add_trade()          │
   │                                  ├────────────────────────────────>│
   │                                  │  13. Update portfolio & balance │
   │                                  │<────────────────────────────────┤
   │  14. Order Confirmation          │  15. Order → Order Book         │
   │      with token, lots, balance   │      → Exec Report → FIX Output │
   │<─────────────────────────────────┤                                 │
   │                                  │                                 │
```

**Key Points**:
- **Login (Steps 1-5)**: Browser sends credentials → Web Server calls Player Service via gRPC → signed JWT token returned to browser
- **Token Storage (Step 6)**: JWT token stored in sessionStorage (browser-only, not URL, prevents leaks)
- **WebSocket Connection (Steps 7-10)**: Browser opens WebSocket with token & username as query params → Web Server validates JWT token with Player Service implicitly → Connection established
- **Trade Execution (Steps 11-15)**: WebSocket order → Web Server calls Player Service gRPC `add_trade()` → Portfolio updated → Order routed to Order Book → Execution report sent back
- **No Session Registry**: Player Service is stateless; each request validates the token implicitly
- **HTTP/2 Multiplexing**: All gRPC calls (login, add_trade, etc.) use single TCP connection with concurrent streams


### Market Simulator

The market simulator consists of multiple components that work together to simulate the behavior of a stock market. It is based on an **event-driven architecture** , where each component communicates with others through message passing using Single Producer Single Consumer (SPSC) and Multi Producer Single Consumer (MPSC) channels.

Here is the high-level architecture of the market simulator:

```text
+-------------+      TCP       +---------------------------+
| FIX clients |--------------->| Web backend / TCP ingress |
+-------------+                +---------------------------+
       ^                             ^                |
       | TCP responses               | HTTP/WS        | crossbeam net_to_fix
       |                             |                v
+-------------+                      |       +--------------------+
|   Browser   |----------------------+       | FIX inbound engine |
+-------------+                              +--------------------+
                                                     |
                                                     | SPSC fix_to_ob
                                                     v
                                           +-----------------------+
                                           | Order-book aggregator |
                                           +-----------------------+
                                             |                  |
                                  SPSC per symbol      SPSC per symbol
                                             v                  v
                                  +----------------+   +----------------+
                                  | OB engine AAPL |   | OB engine N... |
                                  +----------------+   +----------------+
                                    |           \        |           \
                          MPSC ob_to_er \       \ MPSC ob_to_db      \ MPSC ob_to_er
                                      v  \       v                    v
                          +----------------------+         +-------------------+
                          | Execution-report eng |         |    DB engine      |
                          +----------------------+         +-------------------+
                                      |                              |
                                      | SPSC er_to_fix               | SQL
                                      v                              v
                          +----------------------+      +------------------------------+
                          | FIX outbound engine  |      | PostgreSQL (market data DB)  |
                          +----------------------+      +------------------------------+
```

Component responsibilities:

| Component | Responsibility |
|---|---|
| Web backend / TCP ingress | Receives HTTP/WebSocket and FIX traffic, forwards events into the internal pipeline, and returns responses to clients. |
| FIX inbound engine | Parses inbound FIX messages and converts them into internal `OrderEvent` messages. |
| Order-book aggregator | Routes incoming order events to the appropriate per-symbol order-book engine. |
| Order-book engine (per symbol) | Maintains symbol state, processes orders, and produces order results. |
| Execution-report engine | Builds execution reports from order results and sends them to the FIX outbound path. |
| FIX outbound engine | Encodes outbound FIX responses and sends them back through ingress/client connections. |
| DB engine | Persists orders/trades/pending state and serves market state loading/recovery. |
| gRPC market-control server | Handles operational control actions (for example reset order book/database state). |
| Player service | Manages authentication, player state, and portfolio updates used by backend/gateway flows. |
| PostgreSQL | Stores market and player persistent data. |


### Player Service

The player service is a gRPC microservice responsible for managing player accounts, authentication, and portfolio management. It provides a gRPC API for the gateway to interact with player data and perform operations such as login, portfolio updates, and player state management.

```text
+------------------+      gRPC       +------------------+
|   web/backend    |---------------> | players service  |
+------------------+                 +------------------+
                                           |
+------------------+   gRPC admin calls    |
|  gateway/admin   |------------------------+
+------------------+                        |
                                           v
                               +----------------------------+
                               |      internal modules      |
                               |  - auth/token              |
                               |  - portfolio               |
                               |  - visitor counter         |
                               |  - admin reset             |
                               +----------------------------+
                                           |
                                           | SQL
                                           v
                               +----------------------------+
                               |         PostgreSQL         |
                               +----------------------------+
```

### Database

The database component is responsible for persisting market data, player information, and other relevant data required by the market simulator. It is implemented using PostgreSQL and is accessed by both the market simulators for storing market events and by the players service for managing player data. It also includes an idempotency database used to prevent duplicate processing of retried requests.

```text
Producers
---------
+------------------+     players, portfolio_lots, visits
| players service  |------------------------------------+
+------------------+                                    |
                                                        v
+------------------+     orders, trades, pending orders +----------------------+
|   DB engine      |----------------------------------->|      PostgreSQL      |
+------------------+                                    +----------------------+
                                                        ^
+------------------+          auth/session reads        |
|   web/backend    |------------------------------------+
+------------------+

Idempotency
-----------
+------------------+       idempotency key lookup/write     +----------------------+
|   web/backend    |--------------------------------------->| Idempotency Database |
+------------------+                                        +----------------------+
```

### Backend

```text
+-------------+      HTTP + WebSocket      +------------------+
|   Browser   |--------------------------->|   web/backend    |
+-------------+                            +------------------+

+-------------+          TCP 5000                    |
| FIX Client  |--------------------------------------+
+-------------+                                      |
                                                     | gRPC
                                                     v
                                            +------------------+
                                            | players service  |
                                            +------------------+

web/backend --> order events --> order-book --> execution-report --> web/backend
                                  | \
                                  |  +--> market-feed
                                  +----> snapshot

web/backend --> FIX routing --> protocol/FIX
```
