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

The frontend build creates `frontend/dist` and its precompressed copy in
`frontend/dist_gzipped`. The release binary embeds and serves
`frontend/dist_gzipped`.

## Verification

Run the backend checks:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Run the frontend checks:

```bash
npm --prefix frontend run check
npm --prefix frontend run build
```

Check patches for whitespace errors:

```bash
git diff --check
```

Application settings live in `config.toml`.
