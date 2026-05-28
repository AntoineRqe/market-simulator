# Frontend - Multi-Market Trading Terminal

A TypeScript + Vite frontend for the market-simulator project. Real-time trading terminal with WebSocket support for multi-market order book visualization.

## Setup

### Prerequisites
- Node.js 18+ (with npm)

### Installation

```bash
cd crates/web/frontend
npm install
```

### Development

Start the development server:

```bash
npm run dev
```

The server will run on `http://localhost:5173` by default.

### Building

Build for production:

```bash
npm run build
```

Output is in `dist/`.

## Architecture

### TypeScript Modules

The codebase is organized into feature-focused modules:

- **types.ts** - Type definitions and interfaces
- **constants.ts** - Global constants and configuration getters
- **utils.ts** - Utility functions (DOM, formatting, etc.)
- **auth.ts** - Authentication and session management
- **main.ts** - Entry point and initialization

### Template Injection

Configuration values from the gateway are injected into `index.html` before module loading:

```html
<script>
  window.__APP_CONFIG__ = {
    LOGIN_GATEWAY_URL: '...',
    CURRENT_MARKET_NAME: '...',
    DEFAULT_SYMBOL: '...',
    KNOWN_MARKETS: [...]
  };
</script>
<script type="module" src="/src/main.ts"></script>
```

The `setTemplateConfig()` function in `constants.ts` receives these values at runtime.

## Development Notes

- TypeScript strict mode enabled for type safety
- Module bundling with Vite for fast development and optimized production builds
- Path aliases configured (`@/*` → `src/*`) for cleaner imports
- Source maps enabled in development and production builds

## Next Steps

The following modules still need to be migrated from the original JavaScript:

- WebSocket connection management
- Order book rendering and updates
- Market data visualization
- Trading order submission
- UI event handling and responsiveness
- Chart rendering (Canvas)
- Log formatting and display
