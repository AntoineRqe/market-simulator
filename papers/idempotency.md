# Idempotency

## Status

**Implemented** in the simulator.

## Where it is implemented

1. `crates/db/src/lib.rs`
   - `idempotency_keys` table
   - `claim_idempotency_key(...)`
   - `update_idempotency_key_response(...)`
2. `crates/web/backend/src/ws.rs`
   - `order_idempotency_key(sender_id, clord_id)`
   - claim/replay/mismatch handling for WebSocket orders
3. `crates/web/backend/src/fix_session.rs`
   - persists FIX responses for idempotent replay

## Idempotency workflow (ASCII)

```text
Client
  |
  | 1) Submit order (same sender_id + clord_id on retry)
  v
Web Backend
  |
  | 2) Build idempotency_key = order_idempotency_key(sender_id, clord_id)
  v
Idempotency DB (idempotency_keys)
  |
  | 3) claim_idempotency_key(key, request_hash)
  |
  +--> [NEW]
  |       |
  |       | 4) Forward order to market pipeline (FIX/OB/ER)
  |       v
  |    Processing result
  |       |
  |       | 5) update_idempotency_key_response(key, final_response, COMPLETED)
  |       v
  |    Return fresh response to client
  |
  +--> [EXISTS + COMPLETED + same hash]
  |       |
  |       | 4b) Read stored response
  |       v
  |    Return stored response (idempotent replay)
  |
  +--> [EXISTS + same key + different hash]
          |
          | 4c) Mark mismatch response
          v
       Return conflict/error (invalid key reuse)
```