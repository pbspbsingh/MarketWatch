# MarketWatch

Local market-analysis web application.

## Workspace

- `frontend/`: React client.
- `server/`: application composition, HTTP/WebSocket endpoints, services, and application storage.
- `crates/market_types/`: shared symbols, exchange identifiers, candles, profiles, and fundamentals; no HTTP, runtime, or database dependencies.
- `crates/market_analysis/`: pure candle aggregation, indicators, relative strength, and performance calculations.
- `crates/db/institutional/`: institutional persistence, migrations, and checked SQL.
- `crates/ownership/`: SEC archive ingestion, source updates, and ownership reports.
- `crates/providers/`: Yahoo, Finviz, NYSE, SEC, news, and AI adapters. Shared HTTP options and throttling live in `http/`; adapters have no server or database dependencies.

Dependency versions and release settings live in the root Cargo workspace. Run
`cargo run` from the repository root; configuration and runtime database paths
remain relative to that working directory. Run `cargo test --workspace` and
`cargo clippy --workspace --all-targets -- -D warnings` to check every crate.

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

The `[server.auth]` section is required. API and frontend response compression is controlled
separately by `compression = true` or `false` under `[server]`; this setting is
required in every mode. Compression is negotiated per request. To reach
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

`/api/events` is the global async data WebSocket. Its application commands and
events carry namespaced domain resources and payloads; industry catalog and
membership are the first subscription types. The shared connection handles
routing, cancellation, and reconnects; domain adapters handle cache policy.
TanStack Query owns server snapshots; Zustand owns shared connection status.
Disconnects retain cached data, display reconnecting status, and replay active
subscriptions when the connection returns. The transport stores no domain data.
TanStack Query holds the industry client cache. Industry membership includes
all Finviz pages without the Top Stocks filters. Missing or expired data is fetched
on demand and reused for 30 days; there is no membership refresh job or manual
refresh endpoint. Verified ETF membership does not expire. Failed acquisitions
preserve the previous membership and fetch time. Ticker imports reject individual
tickers whose industry membership or profile cannot be verified.

The open Market Watch universe shows group ticker counts and supports CNT ordering.
Industry counts come from Finviz's group overview, with first-page metadata totals
for omitted industries. Counts are cached with the catalog without loading group
memberships. The ticker column stays empty until groups are selected and clears
when the last selection is removed. Bounded lists retain their full-list behavior.

Generate the TypeScript contracts from Rust after changing these wire types:

```bash
cargo run -- --export-contracts
cargo run -- --export-contracts --check
```

These commands do not start the server or open the databases. Other existing
features retain their current transports while they are migrated incrementally.

Each TickerLens instance has a scoped Zustand store for group/ticker selections,
filter settings, sorting, and group display preferences. URL parameters serialize
the shareable selection and restore it on navigation. Zustand persists preferences
under `market-watch.ticker-lens-preferences`; filter enablement survives reload only
when pinned. Custom metric sorts belong to their current view. Server snapshots
stay in TanStack Query.

The global `/api/events` connection carries industry counts and performance plus
ticker performance, ADR, and dollar volume. Ranking and candle
commits push updated metrics to active subscriptions. The server applies
ticker filters and pushes additions/removals as metrics change. Sorting stays in
the client; changing a sort does not send a subscription command. Filter-only
200SMA status is evaluated on the server and omitted from metric payloads. The older
dedicated ticker WebSocket has been removed. Yahoo chart/live-price transports
remain separate while their migration continues.

Ticker subscriptions accept industry keys, theme IDs (including Unassigned), or
explicit symbols for bounded lists. The backend resolves group membership, applies
filters, and streams rows and totals. Committed membership changes update active
subscriptions; reconnect snapshots remove rows that no longer belong. The client
does not fetch group members or maintain membership revision keys.

## Institutional ownership

The Institutions tab loads only when opened. Enable SEC access with
`SEC_USER_AGENT='MarketWatch/3.0 your-contact@email.com'` or
`institutions.user_agent` in local `config.toml`. SEC files are downloaded into a
unique OS temporary directory, imported one at a time, and removed after use.
Failed updates also clean up their temporary files. Initial preparation downloads
about 3.7 GB and imports it into `institutions.sqlite` beside the main database.
Set `institutions.database_url` to change the database location.
The first import takes time; later ticker views use indexed queries without
opening ZIPs. Source ETags and modification dates survive restarts in SQLite,
allowing conditional checks without keeping the ZIPs. Deleting the database
requires downloading and importing the sources again.

SEC updates are checked on demand, at most once per 24 hours. The timestamp is
held in memory; restarting resets it. Refresh checks immediately. Stored HTTP
validators skip unchanged archives. One source update/import runs at a time and
continues if the viewer closes the tab. Existing data remains readable during imports through
SQLite WAL transactions. Normal visits return imported history while checking
for updates in the background; Refresh waits for the update. Each report is
calculated from stored filings and holdings rather than a saved report cache.

The server owns `server/migrations/` and `server/.sqlx/`. The `institutional`
crate owns its migrations and SQLx metadata. Its `sqlx.toml` uses
`INSTITUTIONS_DATABASE_URL` from that crate's `.env`; the server uses
`DATABASE_URL` from the root `.env`.
With `SQLX_OFFLINE=true`, Cargo checks static SQL against the committed metadata
without requiring running databases. This can be supplied by a global Cargo
override; the repository does not provide a project-level `.cargo` configuration.
Set `SQLX_OFFLINE=false` when regenerating metadata against the actual databases.
Runtime paths come from `config.toml`. Apply migrations to the local databases
before checking new queries:

```bash
cargo sqlx database setup --source server/migrations  # main database, root .env
cd crates/db/institutional
cp .env.example .env                # first setup only; set your absolute DB path
cargo sqlx database setup           # ownership database, using this crate's .env
cd ../../..
SQLX_OFFLINE=false cargo sqlx prepare --workspace -- --all-targets
SQLX_OFFLINE=true cargo test --workspace --locked --offline
```

Use absolute database URLs when preparing queries so paths are independent of
the owning crate directory. Run institution database commands from that crate
directory so SQLx reads its local configuration.
Both schemas work without SEC records. The application
also applies migrations when opening each database. Commit refreshed `.sqlx`
metadata after changing queries; offline builds use it without live databases.
The migration CLI needs SQLx 0.9 with the `sqlite,sqlx-toml` features:
`cargo install sqlx-cli --version 0.9.0 --locked --no-default-features --features sqlite,sqlx-toml`.

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

The frontend build creates `frontend/dist`, which the release binary embeds and serves.
`server.compression` controls negotiated gzip/deflate compression for both API and frontend responses.

## Verification

Run the backend checks:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --workspace
```

Run the frontend checks:

Type checking uses TypeScript 7. Oxlint and its native TypeScript-aware engine
provide JavaScript, TypeScript, and React lint checks without ESLint or TypeScript 6.

```bash
npm --prefix frontend run check
npm --prefix frontend run build
```

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
