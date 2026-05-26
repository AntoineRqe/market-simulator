use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::encoding::text::encode;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::gauge::Gauge;
use prometheus_client::metrics::histogram::{Histogram, exponential_buckets};
use prometheus_client::registry::Registry;
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct MethodLabels {
    method: String,
}

#[derive(Clone)]
pub struct PlayerMetrics {
    requests_total: Family<MethodLabels, Counter>,
    grpc_errors_total: Family<MethodLabels, Counter>,
    in_flight: Family<MethodLabels, Gauge>,
    latency_us: Family<MethodLabels, Histogram, fn() -> Histogram>,
}

impl PlayerMetrics {
    pub fn new() -> Self {
        fn histogram_ctor() -> Histogram {
            Histogram::new(exponential_buckets(10.0, 2.0, 20))
        }
        Self {
            requests_total: Family::default(),
            grpc_errors_total: Family::default(),
            in_flight: Family::default(),
            latency_us: Family::new_with_constructor(histogram_ctor),
        }
    }

    fn labels(method: &'static str) -> MethodLabels {
        MethodLabels {
            method: method.to_string(),
        }
    }

    pub fn start_rpc(self: &Arc<Self>, method: &'static str) -> RpcTimer {
        let labels = Self::labels(method);
        self.requests_total.get_or_create(&labels).inc();
        self.in_flight.get_or_create(&labels).inc();
        RpcTimer {
            metrics: Arc::clone(self),
            method,
            start: Instant::now(),
            grpc_ok: true,
        }
    }

    fn finish_rpc(&self, method: &'static str, elapsed_us: f64, grpc_ok: bool) {
        let labels = Self::labels(method);
        self.in_flight.get_or_create(&labels).dec();
        if !grpc_ok {
            self.grpc_errors_total.get_or_create(&labels).inc();
        }
        self.latency_us.get_or_create(&labels).observe(elapsed_us);
    }
}

pub struct RpcTimer {
    metrics: Arc<PlayerMetrics>,
    method: &'static str,
    start: Instant,
    grpc_ok: bool,
}

impl RpcTimer {
    pub fn mark_grpc_error(&mut self) {
        self.grpc_ok = false;
    }
}

impl Drop for RpcTimer {
    fn drop(&mut self) {
        let elapsed_us = self.start.elapsed().as_micros() as f64;
        self.metrics.finish_rpc(self.method, elapsed_us, self.grpc_ok);
    }
}

pub fn create_metrics_registry(metrics: &PlayerMetrics) -> Registry {
    let mut registry = Registry::default();
    registry.register(
        "players_rpc_requests_total",
        "Total gRPC requests handled by players service, by method",
        metrics.requests_total.clone(),
    );
    registry.register(
        "players_rpc_grpc_errors_total",
        "Total transport-level gRPC errors in players service, by method",
        metrics.grpc_errors_total.clone(),
    );
    registry.register(
        "players_rpc_in_flight",
        "Current in-flight gRPC requests in players service, by method",
        metrics.in_flight.clone(),
    );
    registry.register(
        "players_rpc_latency_us",
        "Players service RPC latency in microseconds, by method",
        metrics.latency_us.clone(),
    );
    registry
}

async fn metrics_handler(State(registry): State<Arc<Registry>>) -> impl IntoResponse {
    let mut buffer = String::new();
    match encode(&mut buffer, &registry) {
        Ok(()) => (StatusCode::OK, buffer).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to encode metrics: {e}"),
        )
            .into_response(),
    }
}

pub async fn serve_metrics(
    registry: Arc<Registry>,
    addr: std::net::SocketAddr,
) -> Result<(), std::io::Error> {
    let app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(registry);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}
