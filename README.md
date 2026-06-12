# MarketWatch

Local market-analysis web application. See [PLAN.md](PLAN.md) for product and architecture requirements.

## Development

Run the backend:

```bash
cargo run
```

Run the frontend development server in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

The Vite development server proxies `/api` requests to Axum at `127.0.0.1:8080`.

## Production Build

```bash
cd frontend
npm run build
cd ..
cargo run --release
```

Axum serves the compiled frontend from `frontend/dist`.

Application settings live in [config.toml](config.toml).
