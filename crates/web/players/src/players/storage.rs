use super::models::{Player, StorageData};
use super::portfolio::PortfolioLot;
use sqlx::{PgPool, Row, query, query_scalar};
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

pub(crate) fn block_on_storage<F>(future: F) -> F::Output
where
    F: Future,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        tokio::task::block_in_place(|| handle.block_on(future))
    } else {
        static STORAGE_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        let runtime = STORAGE_RUNTIME.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("player-store-db")
                .build()
                .expect("failed to build shared tokio runtime for player store")
        });
        runtime.block_on(future)
    }
}

pub(crate) async fn create_player_tables(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    query("SELECT pg_advisory_xact_lock($1)")
        .bind(42_4243_i64)
        .execute(&mut *tx)
        .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS players (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            tokens DOUBLE PRECISION NOT NULL,
            connection_count BIGINT NOT NULL DEFAULT 0,
            ips_json TEXT NOT NULL DEFAULT '[]',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS player_order_owners (
            cl_ord_id TEXT PRIMARY KEY,
            username TEXT NOT NULL REFERENCES players(username) ON DELETE CASCADE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS portfolio_lots (
            id          BIGSERIAL PRIMARY KEY,
            username    TEXT NOT NULL REFERENCES players(username) ON DELETE CASCADE,
            symbol      TEXT NOT NULL,
            quantity    DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
            price       DOUBLE PRECISION NOT NULL,
            purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;

    query(
        "CREATE INDEX IF NOT EXISTS portfolio_lots_user_symbol ON portfolio_lots(username, symbol, purchased_at)",
    )
    .execute(&mut *tx)
    .await?;

    query(
        "CREATE INDEX IF NOT EXISTS portfolio_lots_user_purchased_at ON portfolio_lots(username, purchased_at)",
    )
    .execute(&mut *tx)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS player_store_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value_bigint BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        "#,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await
}

pub(crate) async fn load_storage_from_db(
    pool: &PgPool,
) -> Result<(HashMap<String, Player>, HashMap<String, String>, u64), sqlx::Error> {
    let player_rows =
        query("SELECT username, password, tokens, connection_count, ips_json FROM players")
            .fetch_all(pool)
            .await?;

    let mut players = HashMap::new();
    for row in player_rows {
        let username: String = row.try_get("username")?;
        let password: String = row.try_get("password")?;
        let tokens: f64 = row.try_get("tokens")?;
        let connection_count_raw: i64 = row.try_get("connection_count")?;
        let ips_json: String = row.try_get("ips_json")?;

        let ips = serde_json::from_str::<Vec<String>>(&ips_json).unwrap_or_default();

        players.insert(
            username.clone(),
            Player {
                username,
                password,
                tokens,
                pending_orders: Vec::new(),
                connection_count: connection_count_raw.max(0) as u64,
                ips,
            },
        );
    }

    let owner_rows = query("SELECT cl_ord_id, username FROM player_order_owners")
        .fetch_all(pool)
        .await?;
    let mut order_owners = HashMap::new();
    for row in owner_rows {
        order_owners.insert(row.try_get("cl_ord_id")?, row.try_get("username")?);
    }

    let total_visitor_count = query_scalar::<_, i64>(
        "SELECT meta_value_bigint FROM player_store_meta WHERE meta_key = 'total_visitor_count'",
    )
    .fetch_optional(pool)
    .await?
    .unwrap_or(0)
    .max(0) as u64;

    Ok((players, order_owners, total_visitor_count))
}

/// Generate a lock ID from username for advisory locking.
fn username_lock_id(username: &str) -> i64 {
    let mut hasher = DefaultHasher::new();
    username.hash(&mut hasher);
    // Convert to i64, ensure positive by taking absolute value.
    (hasher.finish() as i64).abs()
}

pub(crate) async fn persist_storage_to_db(
    pool: &PgPool,
    data: &StorageData,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    for player in data.players.values() {
        // Acquire advisory lock for this username to prevent deadlocks
        // when multiple markets try to update the same player simultaneously.
        let lock_id = username_lock_id(&player.username);
        query("SELECT pg_advisory_lock($1)")
            .bind(lock_id)
            .execute(&mut *tx)
            .await?;

        let ips_json = serde_json::to_string(&player.ips).unwrap_or_else(|_| "[]".to_string());
        query(
            r#"
            INSERT INTO players (username, password, tokens, connection_count, ips_json)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (username) DO UPDATE SET
                password = EXCLUDED.password,
                tokens = EXCLUDED.tokens,
                connection_count = EXCLUDED.connection_count,
                ips_json = EXCLUDED.ips_json,
                updated_at = NOW()
            "#,
        )
        .bind(&player.username)
        .bind(&player.password)
        .bind(player.tokens)
        .bind(player.connection_count as i64)
        .bind(ips_json)
        .execute(&mut *tx)
        .await?;

        // Release advisory lock (automatically released when transaction ends).
        query("SELECT pg_advisory_unlock($1)")
            .bind(lock_id)
            .execute(&mut *tx)
            .await?;
    }

    query("DELETE FROM player_order_owners")
        .execute(&mut *tx)
        .await?;

    for (cl_ord_id, username) in &data.order_owners {
        query(
            r#"
            INSERT INTO player_order_owners (cl_ord_id, username)
            VALUES ($1, $2)
            ON CONFLICT (cl_ord_id) DO UPDATE SET
                username = EXCLUDED.username,
                updated_at = NOW()
            "#,
        )
        .bind(cl_ord_id)
        .bind(username)
        .execute(&mut *tx)
        .await?;
    }

    query(
        r#"
        INSERT INTO player_store_meta (meta_key, meta_value_bigint)
        VALUES ('total_visitor_count', $1)
        ON CONFLICT (meta_key) DO UPDATE SET
            meta_value_bigint = EXCLUDED.meta_value_bigint,
            updated_at = NOW()
        "#,
    )
    .bind(data.total_visitor_count as i64)
    .execute(&mut *tx)
    .await?;

    tx.commit().await
}

pub async fn load_portfolio_lots_for_user(
    pool: &PgPool,
    username: &str,
) -> Result<Vec<PortfolioLot>, sqlx::Error> {
    let rows = query(
        "SELECT id, username, symbol, quantity, price, purchased_at \
         FROM portfolio_lots WHERE username = $1 ORDER BY purchased_at ASC",
    )
    .bind(username)
    .fetch_all(pool)
    .await?;

    let mut lots = Vec::with_capacity(rows.len());
    for row in rows {
        lots.push(PortfolioLot {
            id: row.try_get("id")?,
            username: row.try_get("username")?,
            symbol: row.try_get("symbol")?,
            quantity: row.try_get("quantity")?,
            price: row.try_get("price")?,
            purchased_at: row.try_get("purchased_at")?,
        });
    }
    Ok(lots)
}

pub async fn insert_portfolio_lot(
    pool: &PgPool,
    username: &str,
    symbol: &str,
    quantity: f64,
    price: f64,
) -> Result<(), sqlx::Error> {
    query("INSERT INTO portfolio_lots (username, symbol, quantity, price) VALUES ($1, $2, $3, $4)")
        .bind(username)
        .bind(symbol)
        .bind(quantity)
        .bind(price)
        .execute(pool)
        .await?;
    Ok(())
}

/// FIFO consumption: reduce the oldest lots first for the given symbol.
pub async fn consume_portfolio_lots_fifo(
    pool: &PgPool,
    username: &str,
    symbol: &str,
    mut sell_qty: f64,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    let rows = query(
        "SELECT id, quantity FROM portfolio_lots \
         WHERE username = $1 AND symbol = $2 \
         ORDER BY purchased_at ASC \
         FOR UPDATE",
    )
    .bind(username)
    .bind(symbol)
    .fetch_all(&mut *tx)
    .await?;

    for row in rows {
        if sell_qty <= 1e-9 {
            break;
        }
        let lot_id: i64 = row.try_get("id")?;
        let lot_qty: f64 = row.try_get("quantity")?;

        if sell_qty >= lot_qty - 1e-9 {
            // Consume entire lot.
            query("DELETE FROM portfolio_lots WHERE id = $1")
                .bind(lot_id)
                .execute(&mut *tx)
                .await?;
            sell_qty -= lot_qty;
        } else {
            // Partially consume lot.
            query("UPDATE portfolio_lots SET quantity = quantity - $1 WHERE id = $2")
                .bind(sell_qty)
                .bind(lot_id)
                .execute(&mut *tx)
                .await?;
            sell_qty = 0.0;
        }
    }

    tx.commit().await
}

pub async fn delete_all_portfolio_lots(pool: &PgPool) -> Result<(), sqlx::Error> {
    query("DELETE FROM portfolio_lots").execute(pool).await?;
    Ok(())
}

pub fn parse_fix_fields(body: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    for part in body.split('│') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        if let Some((k, v)) = token.split_once('=') {
            fields.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    fields
}

pub fn parse_f64(v: Option<&str>) -> f64 {
    v.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
}
