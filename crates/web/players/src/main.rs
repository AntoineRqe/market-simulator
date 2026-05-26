use clap::Parser;
use config::PlayersConfig;
use std::sync::Arc;
use tonic::transport::Server;
use tracing::info;

use players::PlayerServiceImpl;
use players::PlayerServiceServer;
use players::metrics::serve_metrics;
use players::players::PlayerStore;
use players::{PlayerMetrics, create_metrics_registry};

#[derive(Parser, Debug)]
#[command(name = "players-server")]
struct Cli {
    #[arg(
        short = 'c',
        long = "config",
        default_value = "crates/config/players/default.json"
    )]
    config_file: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();
    let config = PlayersConfig::parse_from_file(&cli.config_file);

    let db_url = config
        .resolve_database_url()
        .expect("players database URL environment variable must be set");
    let addr = format!("{}:{}", config.grpc.ip, config.grpc.port).parse()?;
    let metrics_addr = format!("{}:{}", config.metrics.ip, config.metrics.port).parse()?;

    info!("Starting Player Server on {}", addr);
    info!("Player metrics endpoint exposed on http://{}/metrics", metrics_addr);

    let player_store = Arc::new(PlayerStore::load_postgres(&db_url));
    let metrics = Arc::new(PlayerMetrics::new());
    let metrics_registry = Arc::new(create_metrics_registry(&metrics));
    let service = PlayerServiceImpl::new(Arc::clone(&player_store), Arc::clone(&metrics));

    tokio::spawn(async move {
        if let Err(e) = serve_metrics(metrics_registry, metrics_addr).await {
            tracing::error!("metrics server failed: {}", e);
        }
    });

    Server::builder()
        .add_service(PlayerServiceServer::new(service))
        .serve(addr)
        .await?;

    Ok(())
}
