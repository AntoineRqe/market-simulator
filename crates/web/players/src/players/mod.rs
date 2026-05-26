pub mod auth;
pub mod portfolio;
pub mod token;
mod models;
mod storage;

pub use auth::{AuthError, hash_password, verify_or_upgrade_password};
pub use models::{INITIAL_TOKENS, PendingOrder, Player, PlayerStore, StoreInner};
pub use portfolio::{HoldingSummary, PortfolioLot};
pub use token::{extract_id_suffix, generate_token};
pub use storage::{
    consume_portfolio_lots_fifo, delete_all_portfolio_lots, insert_portfolio_lot,
    load_portfolio_lots_for_user, parse_f64, parse_fix_fields,
};

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use utils::market_name;

use models::StorageData;
use storage::{create_player_tables, load_storage_from_db, persist_storage_to_db};
pub(crate) use storage::block_on_storage;

impl PlayerStore {
    fn resolve_username_from_sender_id(inner: &StoreInner, sender_id: &str) -> Option<String> {
        let sender = sender_id.trim();
        if sender.is_empty() {
            return None;
        }

        if inner.players.contains_key(sender) {
            return Some(sender.to_string());
        }

        let normalized_sender = sender.to_ascii_uppercase();
        inner
            .players
            .keys()
            .find(|username| username.trim().to_ascii_uppercase() == normalized_sender)
            .cloned()
    }

    /// Load the store from PostgreSQL. If `should_persist` is false, this instance will not
    /// write changes back to the database (for secondary market instances).
    pub fn load_postgres(database_url: &str) -> Self {
        Self::load_postgres_with_persistence(database_url, true)
    }

    pub fn load_postgres_read_only(database_url: &str) -> Self {
        Self::load_postgres_with_persistence(database_url, false)
    }

    fn load_postgres_with_persistence(database_url: &str, should_persist: bool) -> Self {
        let load_pool = Arc::new(
            block_on_storage(db::connect(database_url))
                .unwrap_or_else(|e| panic!("failed to connect player store to postgres: {e}")),
        );

        block_on_storage(create_player_tables(&load_pool))
            .unwrap_or_else(|e| panic!("failed to create player store tables: {e}"));

        let (players, order_owners, total_visitor_count) =
            block_on_storage(load_storage_from_db(&load_pool))
                .unwrap_or_else(|e| panic!("failed to load player store from postgres: {e}"));

        tracing::info!(
            "[{}] Player store: {} player(s) loaded from PostgreSQL",
            market_name(),
            players.len(),
        );

        let pool = if should_persist {
            Some(load_pool)
        } else {
            // Read-only instances don't need to keep the pool
            None
        };

        PlayerStore {
            inner: Arc::new(Mutex::new(StoreInner {
                players,
                order_owners,
                processed_exec_ids: HashSet::new(),
                total_visitor_count,
                pool,
                holdings_cache: HashMap::new(),
                flush_in_progress: false,
                flush_pending: false,
            })),
        }
    }

    #[cfg(test)]
    fn from_storage_data(storage: StorageData) -> Self {
        PlayerStore {
            inner: Arc::new(Mutex::new(StoreInner {
                players: storage.players,
                order_owners: storage.order_owners,
                processed_exec_ids: HashSet::new(),
                total_visitor_count: storage.total_visitor_count,
                pool: None,
                holdings_cache: HashMap::new(),
                flush_in_progress: false,
                flush_pending: false,
            })),
        }
    }

    /// Authenticate an existing player **or** register a brand-new one with
    /// [`INITIAL_TOKENS`] tokens and an empty pending-order list.
    ///
    /// Returns `Ok(username)` on success, `Err(reason)` if the player exists
    /// but the password does not match.
    /// Return a snapshot of the player's current state, or `None` if unknown.
    pub fn get_player(&self, username: &str) -> Option<Player> {
        self.inner.lock().unwrap().players.get(username).cloned()
    }

    /// Record a newly placed order.
    ///
    /// Token balance does NOT change at NEW time; it changes only when
    /// transactions (fills) occur via execution reports.
    pub fn add_pending_order(&self, username: &str, order: PendingOrder) {
        let mut inner = self.inner.lock().unwrap();
        let cl_ord_id = order.cl_ord_id.clone();
        let mut inserted = false;
        if let Some(player) = inner.players.get_mut(username) {
            player.pending_orders.push(order);
            inserted = true;
        }

        if inserted {
            inner.order_owners.insert(cl_ord_id, username.to_string());
        }
        drop(inner);
        self.flush();
    }

    /// Remove a pending order by `cl_ord_id`.
    ///
    /// Token balance does NOT change on cancel/remove; only fills move tokens.
    pub fn remove_pending_order(&self, username: &str, cl_ord_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(player) = inner.players.get_mut(username) {
            if let Some(pos) = player
                .pending_orders
                .iter()
                .position(|o| o.cl_ord_id == cl_ord_id)
            {
                player.pending_orders.remove(pos);
            }
        }

        inner.order_owners.remove(cl_ord_id);
        drop(inner);
        self.flush();
    }

    /// Return a snapshot of all known cl_ord_id -> username associations.
    pub fn get_order_owners(&self) -> HashMap<String, String> {
        self.inner.lock().unwrap().order_owners.clone()
    }

    /// Hydrate cl_ord_id -> username associations during startup.
    ///
    /// Each tuple is `(cl_ord_id, sender_id)` from persisted pending orders.
    /// Only sender IDs matching known players are accepted.
    ///
    /// Returns the number of associations inserted or updated.
    pub fn hydrate_order_owners_from_sender_ids(&self, entries: &[(String, String)]) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let mut updated = 0usize;

        for (cl_ord_id, sender_id) in entries {
            let cl_ord_id = cl_ord_id.trim();
            let sender_id = sender_id.trim();
            if cl_ord_id.is_empty() || sender_id.is_empty() {
                continue;
            }

            let Some(owner_username) = Self::resolve_username_from_sender_id(&inner, sender_id)
            else {
                continue;
            };

            let replaced = inner
                .order_owners
                .insert(cl_ord_id.to_string(), owner_username.clone());
            if replaced.as_deref() != Some(owner_username.as_str()) {
                updated += 1;
            }
        }

        drop(inner);
        if updated > 0 {
            self.flush();
        }

        updated
    }

    /// Record a successful websocket connection for a player and persist
    /// associated client IP (if provided).
    /// Reset a player's token balance to the initial amount.
    ///
    /// Returns `true` if the player exists and was updated.
    pub fn reset_tokens(&self, username: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(player) = inner.players.get_mut(username) else {
            return false;
        };

        player.tokens = INITIAL_TOKENS;
        drop(inner);
        self.flush();
        true
    }

    /// Reset every player's token balance to the initial amount.
    ///
    /// Returns the number of players updated.
    pub fn reset_all_tokens(&self) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let mut updated = 0usize;

        for player in inner.players.values_mut() {
            player.tokens = INITIAL_TOKENS;
            updated += 1;
        }

        drop(inner);
        self.flush();
        updated
    }

    /// Reset player-side market state after a global market reset.
    ///
    /// Clears all pending orders and holdings for every player and drops execution-report
    /// deduplication state so future reports are processed normally.
    ///
    /// Returns `(players_touched, orders_removed)`.
    pub fn reset_market_state(&self) -> (usize, usize) {
        let mut inner = self.inner.lock().unwrap();
        let mut players_touched = 0usize;
        let mut orders_removed = 0usize;

        for player in inner.players.values_mut() {
            if !player.pending_orders.is_empty() {
                orders_removed += player.pending_orders.len();
                player.pending_orders.clear();
                players_touched += 1;
            }
        }

        inner.order_owners.clear();
        inner.processed_exec_ids.clear();
        inner.holdings_cache.clear();
        let pool = inner.pool.clone();
        drop(inner);

        // Always persist to keep on-disk state aligned with the market reset.
        self.flush();

        // Clear all portfolio lots.
        if let Some(pool) = pool {
            if let Err(e) = block_on_storage(delete_all_portfolio_lots(&pool)) {
                tracing::error!(
                    "[{}] Failed to clear portfolio lots on market reset: {e}",
                    market_name()
                );
            }
        }

        (players_touched, orders_removed)
    }

    /// Return the all-time total visitor count persisted across restarts.
    pub fn total_visitors(&self) -> u64 {
        self.inner.lock().unwrap().total_visitor_count
    }

    /// Increment the all-time visitor counter and persist immediately.
    /// Returns the new total.
    pub fn record_visit(&self) -> u64 {
        let new_total = {
            let mut inner = self.inner.lock().unwrap();
            inner.total_visitor_count = inner.total_visitor_count.saturating_add(1);
            inner.total_visitor_count
        };
        self.flush();
        new_total
    }

    /// Sync visitor counts from the backend (update total visitor count).
    /// Called by the backend to persist its tracked visitor metrics.
    pub fn update_visitor_count(&self, total: i32) {
        let new_total = total as u64;
        let mut inner = self.inner.lock().unwrap();
        // Use max to avoid overwriting with lower value (in case of race conditions)
        inner.total_visitor_count = inner.total_visitor_count.max(new_total);
        drop(inner);
        self.flush();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Persist the current in-memory state to PostgreSQL asynchronously.
    /// Uses single-flight semantics: at most one background flush task is active at a time.
    /// Additional flush requests while a flush is running are coalesced into one follow-up run.
    /// Retries up to 3 times with exponential backoff on transient deadlocks.
    pub fn flush(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.pool.is_none() {
            return;
        }

        if inner.flush_in_progress {
            inner.flush_pending = true;
            return;
        }

        inner.flush_in_progress = true;
        drop(inner);

        let store = self.clone();
        tokio::spawn(async move {
            const MAX_RETRIES: u32 = 3;
            loop {
                let (pool, data) = {
                    let inner = store.inner.lock().unwrap();
                    let Some(pool) = inner.pool.clone() else {
                        drop(inner);
                        let mut inner = store.inner.lock().unwrap();
                        inner.flush_in_progress = false;
                        inner.flush_pending = false;
                        return;
                    };
                    let data = StorageData {
                        players: inner.players.clone(),
                        order_owners: inner.order_owners.clone(),
                        total_visitor_count: inner.total_visitor_count,
                    };
                    (pool, data)
                };

                let mut persisted = false;
                for attempt in 0..MAX_RETRIES {
                    match persist_storage_to_db(&pool, &data).await {
                        Ok(_) => {
                            persisted = true;
                            break;
                        }
                        Err(e)
                            if e.to_string().contains("deadlock") && attempt < MAX_RETRIES - 1 =>
                        {
                            let backoff_ms = 100 * (2_u64.pow(attempt));
                            tracing::warn!(
                                "[{}] Deadlock persisting player data (attempt {}), retrying in {}ms: {e}",
                                market_name(),
                                attempt + 1,
                                backoff_ms
                            );
                            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                        }
                        Err(e) => {
                            tracing::error!(
                                "[{}] Failed to persist player data to PostgreSQL after {} attempts: {e}",
                                market_name(),
                                MAX_RETRIES
                            );
                            break;
                        }
                    }
                }

                let mut inner = store.inner.lock().unwrap();
                if inner.flush_pending {
                    inner.flush_pending = false;
                    drop(inner);
                    continue;
                }
                inner.flush_in_progress = false;
                drop(inner);

                if !persisted {
                    return;
                }
                return;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trade_updates_both_participants_without_pending_orders_loaded() {
        let mut players = HashMap::new();
        players.insert(
            "alice".to_string(),
            Player {
                username: "alice".to_string(),
                password: "pw".to_string(),
                tokens: 10000.0,
                pending_orders: Vec::new(),
                connection_count: 0,
                ips: Vec::new(),
            },
        );
        players.insert(
            "bob".to_string(),
            Player {
                username: "bob".to_string(),
                password: "pw".to_string(),
                tokens: 10000.0,
                pending_orders: Vec::new(),
                connection_count: 0,
                ips: Vec::new(),
            },
        );

        let store = PlayerStore::from_storage_data(StorageData {
            players,
            order_owners: HashMap::from([
                ("ALICESELL1".to_string(), "alice".to_string()),
                ("BOBBUY1".to_string(), "bob".to_string()),
            ]),
            total_visitor_count: 0,
        });

        // Status 0 (New): Deduct tokens for BUY order
        let buyer_new =
            "35=8 │ 39=0 │ 11=BOBBUY1 │ 54=1 │ 55=AAPL │ 44=100 │ 38=5 │ 151=5 │ 17=E-BUY-0";
        assert!(store.apply_fix_execution_report(buyer_new).is_ok());

        // Status 2 (Filled): Execute the fill (tokens already deducted)
        let buyer_fill =
            "35=8 │ 39=2 │ 11=BOBBUY1 │ 54=1 │ 55=AAPL │ 31=100 │ 32=5 │ 151=0 │ 17=E-BUY-1";
        assert!(store.apply_fix_execution_report(buyer_fill).is_ok());

        // Status 2 (Filled): SELL order execution (credit tokens)
        let seller_fill =
            "35=8 │ 39=2 │ 11=ALICESELL1 │ 54=2 │ 55=AAPL │ 31=100 │ 32=5 │ 151=0 │ 17=E-SELL-1";
        assert!(store.apply_fix_execution_report(seller_fill).is_ok());

        let alice = store.get_player("alice").expect("alice exists");
        let bob = store.get_player("bob").expect("bob exists");

        // Alice: started with 10000, filled 5 @ 100 (SELL) = +500 → 10500
        assert!(
            (alice.tokens - 10500.0).abs() < 1e-9,
            "alice tokens: {}",
            alice.tokens
        );

        // Bob: started with 10000, deducted 5*100=500 on status=0 → 9500
        assert!(
            (bob.tokens - 9500.0).abs() < 1e-9,
            "bob tokens: {}",
            bob.tokens
        );

        let owners = store.get_order_owners();
        assert!(!owners.contains_key("ALICESELL1"));
        assert!(!owners.contains_key("BOBBUY1"));
    }
}
