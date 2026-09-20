# MarketWatch

Local market-analysis web application.

## Configuration

Create `config.toml` from the provided template before starting the backend:

```bash
cp config.example.toml config.toml
```

When `config.toml` is missing, the backend prints the template and exits.

Before starting the server, generate a password hash:

```bash
cargo run --bin hash_password
```

You can also pass the password as an argument with
`cargo run --bin hash_password -- 'your-long-password'`, but it may be visible in
shell history and process listings.

Use a strong password, then paste the printed Argon2id hash into
`[server.auth].password_hash` in `config.toml`. The example value is deliberately
invalid, so the server refuses to start until it is replaced. Keep the password
in a password manager and restrict the local config file to the server user:

```bash
chmod 600 config.toml
```

The server challenges every route with HTTP Basic authentication, including
the frontend and WebSocket handshakes. Failed requests are logged with the
client IP and attempted username. A validated Basic header is cached in memory,
so repeated requests with the same credentials skip Argon2. Uncached password
checks are limited to one every five seconds. Tailscale Funnel supplies HTTPS;
keep the backend bound to `127.0.0.1` and point Funnel at that local port.

## Development

Run the backend API:

```bash
cargo run
```

The default build bundles SQLite. To link against the system SQLite library instead:

```bash
cargo run --no-default-features --features sqlite-unbundled
```

The unbundled build requires SQLite development files and libclang.

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
