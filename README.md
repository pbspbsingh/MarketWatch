# MarketWatch

Local market-analysis web application.

## Configuration

Create `config.toml` from the provided template before starting the backend:

```bash
cp config.example.toml config.toml
```

When `config.toml` is missing, the backend prints the template and exits.

To run without authentication on this computer, replace the credentials in
`config.toml` with an explicit mode:

```toml
[server.auth]
mode = "none"
```

The `[server.auth]` section is required. API response compression is controlled
separately by `compression = true` or `false` under `[server]`; this setting is
required in every mode. Embedded frontend assets remain precompressed. To reach
the app from other devices, set `address = "0.0.0.0:8080"` under `[server]`.
This listens on every IPv4 interface, so restrict access with your firewall.
Basic-auth mode can also bind there, but Basic credentials are exposed over
plain HTTP; use TLS before allowing remote access. Existing username/hash
configurations stay authenticated.

To keep HTTP Basic authentication, generate a password hash:

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

When configured, the server challenges every route with HTTP Basic
authentication, including the frontend and WebSocket handshakes. Failed
requests are logged with the client IP and, when available, attempted username.
For a loopback HTTPS proxy, the server uses
its single `X-Forwarded-For` IP only when `X-Forwarded-Host` matches `Host`;
otherwise it logs the direct peer IP.
A validated Basic header is cached in memory, so repeated requests with the
same credentials skip Argon2. Uncached password checks are limited to five per
five seconds per client IP. Tailscale Funnel supplies HTTPS;
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

## Institutional ownership

The Institutions tab loads only when opened. Enable SEC access with
`SEC_USER_AGENT='MarketWatch/3.0 your-contact@email.com'` or
`institutions.user_agent` in local `config.toml`. Original source ZIPs and the SEC
ticker catalog live under `data/institutions` (`institutions.data_directory` can
override this). Initial preparation downloads about 3.7 GB.

SEC updates are checked on demand, at most once per 24 hours. The timestamp is
held in memory; restarting resets it. Refresh checks immediately. Only changed
files are downloaded. One ownership workflow runs at a time, including transfers
and scans. Disconnecting cancels it. Each tab load rereads the ZIPs and computes
its view; there is no ownership database, saved index, or calculated-report cache.

N-PORT covers registered funds, not all institutional managers. Missing filings
are unconfirmed rather than exits. Stock splits are checked through the existing
Yahoo provider; unavailable split data suppresses addition/reduction signals.
Ownership percentages show approximate share-count dates and are withheld for
issuers with multiple listed share classes or unverified depositary-receipt ratios. Tracked funds are personal selections
saved in the browser, not performance ratings.

The view separates sponsor breadth, position changes, and sponsor quality in line
with [IBD's institutional sponsorship guidance](https://shop.investors.com/images/promotional/20-Rules_102808.pdf).
Quality stays ungraded because these SEC source files do not supply verified fund
performance ratings. A rising number of owners can coexist with existing owners
reducing their positions; the UI presents those signals separately.

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
node --test frontend/scripts/*.test.mjs
```

Run the complete Trade Logs checks, including isolated Chrome interaction and
viewport tests (Chrome/Chromium and installed frontend dependencies required):

```bash
./scripts/check-trade-logs.sh
```

Browser checks and performance measurements share one permission-friendly entry point:

```bash
node frontend/scripts/trade-statistics-browser.mjs
node frontend/scripts/trade-statistics-browser.mjs --performance
```

The default runs isolated fixtures. Performance mode requires a frontend build and
the local backend on port 8080; it uses read-only interactions against the journal.
Screenshots, timing reports, and a CPU profile are written under `/tmp`.

Statistics has separate Overview, Distribution, Tags, Timing, Duration, and Symbols
views. Global filters define the baseline; the Statistics tag selector refines it
with Any/All matching and respects the tag source filter. Return percentages use
after-fee profit divided by gross entry notional. Charts default to closed trades.
Include open trades adds server-calculated total P&L at each ticker's latest completed
daily close, including realized partial exits and recorded fees. Missing or outdated
valuations withhold charts until prices are available. The cumulative series books
closed trades on final exit and open positions once on their current price date;
it does not reconstruct historical unrealized P&L or account equity.

Check patches for whitespace errors:

```bash
git diff --check
```

Application settings live in `config.toml`.
