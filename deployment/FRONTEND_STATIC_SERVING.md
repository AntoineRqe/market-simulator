# Frontend Static Assets Serving Strategy

## Problem

The Vite-built frontend creates:
- `dist/index.html` - Main HTML template (24.14 KB)
- `dist/assets/index-*.js` - JavaScript bundle (9.11 KB)
- `dist/assets/index-*.js.map` - Source map (64.64 KB)

The Rust gateway embeds `index.html` directly, but the HTML references `/assets/index-*.js` which isn't available.

## Solutions Evaluated

### Option 1: Embed Everything as Base64 (Not Recommended)
- Inline assets as base64 data URIs in HTML
- Pros: Single file, no file serving needed
- Cons: Increases HTML size 33%, breaks source maps, complex build

### Option 2: Serve from Static Directory (Recommended)
- Gateway serves `/assets/*` from a static directory
- HTML references work as-is
- Pros: Standard web server pattern, easy to debug, small HTML
- Cons: Need to serve files in Docker

### Option 3: Nginx Reverse Proxy (Production)
- Nginx serves `/assets/*` and `/app` routes
- Market servers don't need file serving
- Pros: Separation of concerns, performant, caching-friendly
- Cons: Adds complexity for local dev

## Implementation (Option 2 - Recommended for MVP)

### Update Gateway to Serve Static Files

```rust
// In gateway.rs or new static.rs module
use tower_http::services::ServeDir;

let assets_service = ServeDir::new("crates/web/frontend/dist/assets");

let app = Router::new()
    .route("/", get(gateway_login_page_handler))
    .route("/app", get(gateway_app_handler))
    .route("/api/markets", get(gateway_markets_handler))
    .route("/api/login", post(gateway_login_handler))
    .nest_service("/assets", assets_service)
    .layer(cors_layer);
```

### Update Dockerfile to Copy Assets

```dockerfile
# In Dockerfile.gateway multi-stage build
FROM frontend-builder as assets-stage
# Assets are in /workspace/crates/web/frontend/dist/assets

FROM ubuntu:24.04
# Copy assets to working directory
COPY --from=frontend-builder /workspace/crates/web/frontend/dist/assets /app/assets
```

## Current Status

✅ Frontend builds with Vite  
✅ Gateway serves `/assets/*` via `tower_http::services::ServeDir`  
✅ Docker image exports `FRONTEND_ASSETS_DIR=/app/frontend-dist/assets`  
✅ dist/assets bundled JavaScript is available at runtime

## Testing

```bash
# 1. Build frontend
npm run build --prefix crates/web/frontend

# 2. Build and run locally
cargo build --bin gateway
./target/debug/gateway --config crates/config/gateway/docker.local.json

# 3. Test in browser
curl http://localhost:9860/app
# Should show HTML with <script src="/assets/index-*.js">

curl http://localhost:9860/assets/index-*.js
# Should return the JavaScript bundle (200)
```

## Production Considerations

1. **CDN**: Copy assets to CDN, update asset paths to CDN URLs
2. **Compression**: Gzip .js files before upload (9.11KB → 3.57KB)
3. **Caching**: Set long cache headers for versioned assets
4. **Cleanup**: Remove old asset files when deploying new versions
