use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// Tokens each new player receives on registration.
pub const INITIAL_TOKENS: f64 = 10_000.0;

/// A single order resting in the order book on behalf of a player.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingOrder {
    pub cl_ord_id: String,
    pub symbol: String,
    /// FIX side: "1" = buy, "2" = sell.
    pub side: String,
    pub qty: f64,
    pub price: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub username: String,
    /// Plaintext password (suitable for a local simulator; hash it for production use).
    pub password: String,
    /// Remaining token balance.
    pub tokens: f64,
    /// Orders currently resting in the order book (not yet filled or cancelled).
    #[serde(default, skip_serializing, skip_deserializing)]
    pub pending_orders: Vec<PendingOrder>,
    /// Total number of authenticated websocket connections observed for this player.
    #[serde(default)]
    pub connection_count: u64,
    /// Unique client IPs seen for this player.
    #[serde(default)]
    pub ips: Vec<String>,
}

impl Player {
    pub fn new(username: String, password_hash: String) -> Self {
        Self {
            username,
            password: password_hash,
            tokens: INITIAL_TOKENS,
            pending_orders: Vec::new(),
            connection_count: 0,
            ips: Vec::new(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct StorageData {
    pub(crate) players: HashMap<String, Player>,
    #[serde(default)]
    pub(crate) order_owners: HashMap<String, String>,
    #[serde(default)]
    pub(crate) total_visitor_count: u64,
}

/// Thread-safe player registry backed by PostgreSQL.
/// Cloning is cheap — the inner state is Arc-backed.
#[derive(Clone)]
pub struct PlayerStore {
    pub inner: Arc<Mutex<StoreInner>>,
}

pub struct StoreInner {
    pub players: HashMap<String, Player>,
    pub order_owners: HashMap<String, String>,
    pub processed_exec_ids: HashSet<String>,
    pub total_visitor_count: u64,
    pub pool: Option<Arc<PgPool>>,
    /// Cached holdings summaries per player. Invalidated on every trade.
    pub holdings_cache:
        HashMap<String, HashMap<String, crate::players::portfolio::HoldingSummary>>,
    /// True while a background flush task is running.
    pub flush_in_progress: bool,
    /// Set when flush is requested while one is already in progress.
    pub flush_pending: bool,
}
