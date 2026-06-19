# MarketWatch

Local market-analysis web application.

## Configuration

Create `config.toml` from the provided template before starting the backend:

```bash
cp config.example.toml config.toml
```

When `config.toml` is missing, the backend prints the template and exits.

## Development

Run the backend API:

```bash
cargo run
```

Run the frontend development server in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

The Vite development server proxies `/api` requests to Axum at `127.0.0.1:8080`. Debug builds do not serve static frontend assets.

## Production Build

```bash
cd frontend
npm run build
cd ..
cargo run --release
```

The release binary embeds and serves `frontend/dist`.

Application settings live in `config.toml`.
