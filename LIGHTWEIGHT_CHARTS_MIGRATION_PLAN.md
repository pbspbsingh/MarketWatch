# TickerLens Lightweight Charts Migration Plan

Status: Active

Implementation branch: `feature/lightweight-ticker-lens-charts`

Merge target: `main` only after manual parity approval

Current checkpoint: task 4.6 implemented and reviewed; awaiting visual approval and commit. RS Line and RS Trend use the active bottom-chart symbol; comparison-only changes update only the top RS series while preserving its candles, indicators, viewport, and ready state.

## Objective

Replace the two TradingView widgets in TickerLens with maintainable Lightweight Charts while preserving the current user workflow. The first delivery is historical-only: synchronized charts, backend-computed indicators, RS overlays, and lazy history. Production live data is a later phase, preceded by a small Yahoo quote/WebSocket feasibility POC.

The existing TradingView implementation remains available on the feature branch until the replacement passes manual parity testing. Work proceeds in small, independently reviewable commits.

## Non-negotiable requirements

- Top chart displays the selected company ticker.
- Bottom chart displays the configured benchmark or selected theme ETF.
- Preserve Daily/Weekly switching, split resizing, symbol switching, theme selection, current styling, loading/error handling, and external TradingView links.
- Preserve candle width across ticker changes and application restarts. Do not persist horizontal position/right offset because symbols have different history lengths.
- Synchronize time range and crosshair between the top and bottom charts.
- Daily overlays: SMA 10, 20, 50, 100, and 200.
- Weekly overlays: EMA 10, 20, and 40.
- Volume overlay: 50-session average on Daily; 10-session average on Weekly.
- The top chart can display RS Line or RS Trend in the upper 30% of the candle pane, or hide the overlay by deselecting the active header mode.
- RS Line is the default; persist the selected RS mode.
- Do not render a current-price horizontal line.
- Do not render a top-left symbol/OHLC/return/volume/indicator legend or crosshair-updated values. Keep native crosshair axis labels.
- Initially load approximately 500 completed daily candles per symbol and retain older history fetched lazily by TickerLens.
- Persist every completed Yahoo candle returned by a lazy-history request; do not purge older candles during maintenance.
- Compute candles, Daily/Weekly aggregation, all moving averages, volume averages, RS Line, and RS Trend on the backend. The frontend renders returned series and performs no financial calculations.
- Live quote/WebSocket data is chart presentation data only. It must not affect persistence, RS/AS, sorting, summaries, notes, or any other analytical flow.

## Accepted parity boundary

Lightweight Charts provides candles, series, panes, scales, pan/zoom, crosshair control, and realtime updates. It does not provide the complete TradingView widget toolbar, drawing suite, or built-in indicator configuration UI.

The TradingView widget toolbar and drawing tools are explicitly not required and will not be recreated. “No noticeable difference” applies to the TickerLens chart workflow, controls, indicators, layout, and interactions defined in this plan.

## Architecture

```text
Yahoo chart API ──> validated completed candles ──> daily_candles
                                                    │
                                                    └─> snapshot/history API ──> MarketChart

Yahoo quote API ──> current-session snapshot ─┐
Yahoo WebSocket ──> live ticks ───────────────┼─> LiveChartManager ─> app WebSocket ─> series.update()
                                              └─> memory only
```

### Ownership boundaries

- `YahooClient`: Yahoo protocol, decoding, throttling, and provider errors.
- Historical candle service: database-first bounded range reads, five-session boundary overlap, and atomic Yahoo upserts.
- Backend chart calculation module: Daily/Weekly aggregation, SMA/EMA, volume averages, RS Line, and RS Trend.
- `LiveChartManager` (deferred): Yahoo WebSocket lifecycle, quote reconciliation, subscriptions, and provisional candles.
- Chart API: provider-independent snapshot, history, and live message contracts.
- `MarketChartContainer`: one symbol's independent snapshot/history request, cancellation, generation, and error state.
- `MarketChart`: Lightweight Charts lifecycle and rendering only; no fetching or calculations.
- TickerLens composition: top/bottom symbols, header controls, split state, synchronization, and error toasts.

No chart component may call Yahoo directly.

### Shared frontend chart foundation

Create a small shared Lightweight Charts layer rather than another feature-local wrapper:

```text
frontend/src/components/lightweight-chart/
  ChartHost.tsx          chart creation, cleanup, autosize, theme, API ref
  chartOptions.ts        shared colors, grid, scales, attribution defaults
  chartSync.ts           guarded date-range and crosshair synchronization
  chartTime.ts           Time/date conversion helpers

frontend/src/features/charts/
  MarketChartContainer.tsx  independent data request, races, history, errors
  MarketChart.tsx           candles, volume, returned series, viewport
  chartSeries.ts            backend-series to Lightweight adapters
```

`ChartHost` must stay presentation-neutral: it owns lifecycle and shared defaults, not market data, indicators, RS logic, or TickerLens state. Avoid a large prop-driven “universal chart” component. Domain components compose the host and own their series.

The new TickerLens chart implementation is a lazy feature boundary. Load it through `React.lazy` so Vite emits the feature separately; verify the production build contains both the feature chunk and the shared `lightweight-charts` chunk before cutover.

Build TickerLens on this foundation. The existing Study and standalone RS charts remain unchanged.

## Data contracts

### Initial chart snapshot

Add a chart-snapshot endpoint requested independently by each `MarketChartContainer`. It returns interval-specific candles and every fully calculated chart series for one symbol. The top-chart request also asks for both RS modes against the active bottom-chart symbol.

Each response includes:

- Symbol.
- Bare provider symbol. Exchange/display identifiers remain owned by the existing chart summary contract.
- Ordered Daily or Weekly OHLCV candles.
- SMA/EMA series and volume-average series required for the interval.
- Optional RS Line and RS Trend series for the top chart.
- Earliest and latest available dates.
- Whether additional history may exist before the returned range.
- Per-symbol error information; one chart's failure must not remove the other chart.

### Lazy historical range

Add a separate endpoint with a provider-neutral contract. It returns a complete recalculated chart snapshot for the requested expanded range, not only raw candles, because changing the range can change indicator values.

- `symbol`
- interval and active bottom-chart comparison symbol when RS is requested
- requested start/end boundaries or candle targets
- ordered candles and all recalculated indicator/RS series
- `has_more_before`

TickerLens reads the requested range from `daily_candles`. If the requested start precedes the earliest stored candle, the shared bounded candle loader fetches only the missing older portion plus five overlapping trading sessions, upserts the response, then reads the complete requested range back from the database. The range always ends at the latest completed session.

This path must retain the existing provider concurrency limit, retry policy, per-symbol lock, and error mapping. `daily_candles` is the historical cache; no second cache or coverage-metadata table is added.

#### Lazy-history query algorithm

All ranges are half-open: `[start, end)`.

1. Let the expanded UI request be `[requested_start, requested_end)`, normalize `requested_start` to the first market session on or after it, and let `stored_start` be the symbol's earliest date in `daily_candles`.
2. If no candle is stored, query Yahoo for `[requested_start, requested_end)`.
3. If `stored_start` is later than that first requested session, set `overlap_end` to the end-exclusive boundary after five trading sessions beginning at `stored_start`, capped at `requested_end`. Query Yahoo for `[requested_start, overlap_end)`.
4. If `stored_start` is on or before the first requested session, do not query Yahoo; serve the range from the database.
5. Validate and atomically upsert Yahoo's ordered response by `(symbol, market_date)`, allowing Yahoo to correct candles inside the overlap.
6. Read `[requested_start, requested_end)` from `daily_candles` and recompute the complete Daily/Weekly indicator and RS snapshot.

Yahoo omissions remain omissions; the application does not fabricate candles. `has_more_before` from a provider-backed request stops the mounted UI at a terminal boundary. That terminal state is intentionally not persisted, so a later mount may probe an IPO boundary again.

Older retained rows do not leak into consumers: the shared loader returns only its explicit bounded range. Any yearly consumer may trigger a one-time backfill when that bounded range is missing, then reuse the database. Calculations that compare symbols align by market date and tolerate different candle counts; single-symbol indicators operate on that symbol's returned range only.

### Deferred live chart stream

Use one application WebSocket per browser session and multiplex symbols.

Client messages:

- Replace desired symbol set.
- Unsubscribe/close.

Server messages:

- Complete provisional daily candle keyed by `symbol + market_date`.
- Per-symbol live status.
- Recoverable connection/capacity error.

The first message after subscribing or reconnecting must be a complete candle snapshot, not a price delta. Later messages replace the same candle idempotently.

## Candle history policy

The initial-response target is approximately 500 trading candles. Implement this using an approximately 760-calendar-day requested range; exact session counts vary by holidays and listings.

- Change the recent-candle horizon only when the new chart endpoint is ready.
- Keep initial snapshot reads bounded to this range even when older candles are stored.
- Persist lazy history on demand; do not add a bulk preload job.
- Remove age-based `daily_candles` cleanup so previously fetched history remains reusable.
- No one-time candle purge is required.

Approximately 500 candles support one visible trading year plus the 199 preceding sessions required to produce a valid SMA 200 at the left edge.

## Chart state and synchronization

Persist only Daily and Weekly `barSpacing` (exact candle width in pixels) in `localStorage`. Keep the current visible logical range stable during in-place history updates, but do not persist horizontal position/right offset across symbols or reloads.

Do not key viewport state by ticker; the purpose is to preserve the same visual scale while scanning symbols. Validate and clamp stored values before applying them.

Top and bottom charts synchronize by market date, never by raw logical index. They share:

- Visible calendar-date range.
- Wheel/pan changes.
- Crosshair date.

Crosshair synchronization maps the date to the target chart’s candle and uses that candle’s price. Missing dates clear the target crosshair instead of inventing a value. Use a reentrancy guard to prevent feedback loops.

Price axes remain independently auto-scaled. Absolute vertical ranges must not be copied between differently priced symbols.

Use the approximately two-year snapshot for initial rendering. Do not fetch lazy history on mount or container resize. Request older history only after an explicit user pan/scroll reaches the left edge; synchronized chart instances expand independently from the same interaction. Previously persisted older history is still returned only through this lazy path.

Each chart owns an `AbortController` and monotonic dataset generation. Symbol/interval changes abort obsolete requests; every snapshot, history response, RS result, and future live message is validated against the active symbol and generation before application. History cursors belong to one generation and cannot leak across ticker changes.

## Indicator definitions

Indicators are pure backend calculations over canonical candles.

- Daily SMA: arithmetic mean over 10/20/50/100/200 sessions.
- Weekly EMA: aggregate daily OHLCV by market week, then calculate EMA 10/20/40 using `alpha = 2 / (period + 1)` and seed with the first full-period SMA.
- Daily volume average: SMA 50 of volume.
- Weekly volume average: SMA 10 of aggregated weekly volume.
- Do not render points before the required warm-up exists.

Keep calculations separate from API serialization so they can be unit-tested and reused.

Colors and styles:

- Daily SMA 10/20/50/100/200: `#3179f5`, `#f6c309`, `#fb9800`, `#fb6500`, `#f60c0c`.
- Weekly EMA 10/20/40: existing app blue, purple, and red.
- Volume-average line: yellow and dotted.
- Candle, volume, grid, scale, and line-width defaults follow the approved reference styling.

### Candle merge and indicator updates

The backend maintains one ordered collection for each request, keyed by market date. Data precedence is:

1. Provisional live candle for the current session.
2. Persisted finalized candle, including Yahoo corrections upserted through the overlap.

Lazy Yahoo responses must deduplicate by date, validate OHLCV, sort ascending, and upsert atomically before the backend reads the requested range. The backend then aggregates the requested interval and recomputes every returned series. Before requesting an expanded snapshot, the frontend captures the visible date range and viewport settings. After replacing series data, it restores the same viewport so candles do not jump.

The frontend replaces data on existing candle/volume/indicator series; it never recreates the chart. Full backend recomputation is intentional: the dataset is small, and prepending history can change the EMA seed and therefore every later Weekly EMA value.

## RS overlay

- Reuse the existing backend RS Line and RS Trend formulas; do not create parallel formulas in the frontend.
- Compare the top ticker against the active bottom-chart symbol.
- Return RS across lazily loaded history as part of each complete backend snapshot.
- Preserve RS Line's current latest-12-month geometric-mean normalization anchor and apply that fixed anchor to older returned ratios. Expanding history must not rescale or change already visible recent RS values.
- Render on an independent hidden left scale constrained to the upper 30% of the top candle pane; candles may overlap it and no left-axis pane is reserved.
- Header toggle: `RS | RST`; clicking the active mode deselects both and hides the overlay. Default to RS and persist all three states.
- Update the RS series without recreating either chart.
- Keep the existing color semantics. Do not add a custom crosshair tooltip/value legend.
- The existing standalone RS panel remains unchanged by this migration.
- Historical delivery contains no provisional candles. A future live chart phase will update the chart-only RS point without entering ranking or persisted analytical flows.

## Completed-session repair and deferred live data

Yahoo chart occasionally omits the latest completed row when its close is unavailable. Historical loading now detects that missing date, fetches an authenticated quote, and persists a complete replacement only when its regular-market timestamp exactly matches the requested completed trading day. Failed or mismatched quote repair remains non-fatal and is retried on the next request. The existing seven-session overlap corrects a previously stored inaccurate candle on a later refresh.

Active-session/provisional repair remains deferred. Before chart implementation began, isolated POCs covered Yahoo quote fields, WebSocket connection/subscription format, heartbeat, and message decoding.

Observed POC results are recorded in `YAHOO_LIVE_POC.md`.

Do not move Yahoo into a separate crate before the POC. First make the existing provider crate-ready with focused `chart`, `profile`, `quote`, `live`, and shared authentication modules. Extract a crate later only if the stabilized provider has another consumer or a clear isolation benefit.

In the later production phase, preserve partial active-session provider rows internally and treat quote/WebSocket data as provisional chart repair, not finalized history.

Quote handling must deserialize optional Yahoo fields including:

- Regular market price and timestamp.
- Previous regular close.
- Market state/session boundaries.
- Current-session open, high, low, and volume when supplied.

Rules:

- Validate the provider timestamp against the market calendar/session before assigning a market date.
- Never fabricate OHLCV values.
- If a complete current-session candle can be constructed, publish it as provisional.
- Refresh quote after WebSocket reconnect to repair missed ticks.
- Final Yahoo chart data supersedes provisional data after it becomes available.
- No provisional candle is written to `daily_candles`.

## Yahoo live subscription manager

Deferred from the first delivery. One shared backend manager will own the Yahoo WebSocket after the POC establishes feasibility.

Connection states:

```text
Disconnected -> Connecting -> Connected -> Backoff -> Connecting
```

Required behavior:

- Exponential reconnect backoff with jitter.
- Detect closed/stale connections and restore desired subscriptions.
- Maintain `symbol -> local subscriber count, last-used time, latest provisional candle, Yahoo subscription state`.
- First local subscriber activates the Yahoo symbol.
- Additional subscribers share the subscription and receive the cached current candle immediately.
- Zero local subscribers starts a five-minute idle timer.
- Reuse the symbol subscription/candle if requested during the grace period.
- After five idle minutes, unsubscribe the symbol and remove its live state.
- If no symbols have local consumers for five minutes, close the Yahoo WebSocket at the same deadline, not five additional minutes later.
- Any new subscriber cancels relevant idle timers and reconnects as needed.

### Capacity policy

Yahoo subscriptions have a hard cap of 100 symbols.

1. Normally retain zero-consumer symbols for the five-minute grace period.
2. When symbol 101 is requested, immediately evict the least-recently-used zero-consumer symbol, bypassing its remaining grace period.
3. Never silently evict a symbol with active local consumers.
4. If all 100 symbols have active consumers, keep the additional chart on historical data and return an explicit live-capacity status.
5. Log connection transitions, subscription counts, idle eviction, capacity eviction, rejection, and reconnect attempts without logging every tick.

## Atomic implementation sequence

Work on only one task at a time, following this sequence unless an explicit user-approved deferral is recorded in the checkpoint. Each code task is one focused commit unless review shows two adjacent tasks are inseparable. Every task must leave the branch buildable; TradingView remains the default until cutover.

After each task: review the diff, run proportional format/type/build checks, report the result, and wait for explicit user approval before committing. After an approved commit, start the next task without requiring separate confirmation. Do not add automated UI, component, endpoint, or integration tests. Add tests only for pure deterministic calculations such as aggregation, indicators, RS, and candle merging; the user performs visual UI verification.

Progress:

- [x] 0.1 — Branch, plan, and captured reference styling.
- [x] 0.2 — Current TickerLens parity checklist.
- [x] 0.3 — Isolated Yahoo quote probe.
- [x] 0.4 — Isolated Yahoo WebSocket probe.
- [x] 0.5 — POC review; deferred production live phase approved as feasible.
- [x] 1.1 — Provider-independent chart interval, candle, and series models.
- [x] 1.2 — Shared Daily close-SMA and volume-average calculations.
- [x] 1.3 — Shared market-week OHLCV aggregation.
- [x] 1.4 — Weekly EMA and volume-average calculations.
- [x] 1.5 — Persistence-backed Daily/Weekly chart snapshot service.
- [x] 1.6 — Independent one-symbol chart snapshot API.
- [x] 1.7 — Shared candle history horizon increased to 760 calendar days.
- [x] 2.1 — Shared Lightweight chart styling and time helpers.
- [x] 2.2 — Shared chart lifecycle host and stable API access.
- [x] 2.3 — Reusable candle and volume chart renderer.
- [x] 2.4 — Backend-provided Daily SMA and Weekly EMA rendering.
- [x] 2.5 — Shared-scale yellow dotted volume-average rendering.
- [x] 2.6 — Independent chart loading, errors, cancellation, and stale-response protection.
- [x] 2.7 — Lazy top-chart comparison mode and verified Vite chunks.
- [x] 3.1 — Independent top and bottom Lightweight chart containers.
- [x] 3.2 — Guarded visible-range synchronization by market date.
- [x] 3.3 — Guarded crosshair synchronization by market date and target close.
- [x] 3.4 — Validated Daily/Weekly viewport persistence.
- [x] 3.5 — TickerLens controls, benchmark switching, and external links preserved.
- [x] 3.6 — Independent chart loading, retry, inline errors, and source-specific toasts.
- [x] 4.1 — Range-aware RS Line and RS Trend calculations with fixed recent normalization.
- [x] 4.2 — Opt-in top-chart snapshots with requested-comparison RS Line and RS Trend.
- [x] 4.3 — Persisted header RS mode toggle with validated RS Line default.
- [x] 4.4 — Selected RS/RST overlay on an independent upper-30% left scale.
- [x] 4.5 — RS mode, symbol, and interval updates reuse the existing chart and series.
- [x] 4.6 — RS comparison follows the active bottom-chart symbol.
- [x] 5.1 — Initial non-persisting Yahoo historical-range fetch (superseded by 5.9).
- [x] 5.2 — Date-keyed persisted/ephemeral merge with canonical precedence.
- [x] 5.3 — Expanded candles and all backend series, including RS, are recomputed over merged history.
- [x] 5.4 — Bounded provider-neutral history contract and availability flags.
- [x] 5.5 — Bounded 50% backward range expansion.
- [x] 5.6 — User-scroll-only TickerLens history trigger.
- [x] 5.7 — Terminal/no-new-candle handling without `setData()`.
- [x] 5.8 — Date-anchored logical viewport preservation and stale-response rejection.
- [x] 5.9 — Database-backed lazy history with five-session overlap and permanent retention.

### 0 — Establish the branch and de-risk Yahoo live access

| ID | Atomic task | Completion check |
|---|---|---|
| 0.1 | Create `feature/lightweight-ticker-lens-charts`; add this plan and capture the reference styling. | Branch starts from current `main`; planning artifacts are committed; worktree is clean. |
| 0.2 | Record a short parity checklist for current TickerLens: symbols, D/W, theme ETF, split, loading/error, keyboard/panel interactions, and external links. | Checklist is reviewable without changing runtime behavior. |
| 0.3 | Build an isolated Yahoo quote probe outside production modules. | Verified response fields, authentication/crumb requirements, rate-limit behavior, and sample fixtures are documented. |
| 0.4 | Build an isolated Yahoo WebSocket probe outside production modules. | Connection URL, encoding, subscribe/unsubscribe messages, heartbeat, timestamps, volume semantics, reconnect behavior, and the unverified 100-symbol app cap are documented from observed traffic. |
| 0.5 | Review the POC and make a go/no-go decision for the deferred live phase. | Historical chart work can proceed regardless; no POC code is wired into the application. |

### 1 — Backend chart calculations and snapshot API

| ID | Atomic task | Completion check |
|---|---|---|
| 1.1 | Add provider-independent chart candle/series/interval models. | Models contain no provider or display identifiers; formats/build checks pass. |
| 1.2 | Implement Daily SMA and volume-average calculations as pure Rust functions. | Fixtures cover periods 10/20/50/100/200, volume 50, insufficient history, and invalid/empty input. |
| 1.3 | Implement market-week OHLCV aggregation. | Fixtures cover week/year boundaries, missing sessions, OHLC rules, and summed volume. |
| 1.4 | Implement Weekly EMA and volume-average calculations. | EMA 10/20/40 uses the documented SMA seed; volume 10 and insufficient-history fixtures pass. |
| 1.5 | Build a chart calculation service that reads existing persisted candles and returns one complete interval snapshot. | Daily and Weekly snapshots contain candles plus all requested MA/EMA/volume series in ascending date order. |
| 1.6 | Add a one-symbol chart snapshot API endpoint. | Top and bottom can call it independently; one request failure cannot affect the other; format/build checks pass. |
| 1.7 | Change initial requested history from 380 to approximately 760 calendar days. | Existing analytical flows still pass; initial chart reads use the new horizon. |

### 2 — Shared Lightweight Charts foundation and one chart

| ID | Atomic task | Completion check |
|---|---|---|
| 2.1 | Add shared chart options and time/date helpers using the approved styling baseline. | No feature behavior changes; shared constants cover candles, volume, grid, scales, and indicator colors. |
| 2.2 | Add `ChartHost` for create/remove, autosize, attribution, and stable API access. | Mount/unmount and resize do not leak chart instances or observers. |
| 2.3 | Add `MarketChart` candle and volume rendering from an already-computed snapshot. | Candles and lower volume overlay render without custom legend/value tooltip or current-price line. |
| 2.4 | Add backend-series adapters and render Daily SMA/Weekly EMA lines. | Correct series/colors appear; updating data does not recreate the chart. |
| 2.5 | Render the yellow dotted Daily-50/Weekly-10 volume-average line. | Line shares the volume region and updates through existing series APIs. |
| 2.6 | Add `MarketChartContainer` with independent loading/error state, `AbortController`, and monotonic generation validation. | Rapid symbol/interval changes cannot display stale responses. |
| 2.7 | Add a temporary TickerLens implementation switch and lazily render only the top Lightweight chart behind it. | TradingView remains the default; production build output verifies separate feature and shared library chunks. |

### 3 — Two-chart TickerLens integration

| ID | Atomic task | Completion check |
|---|---|---|
| 3.1 | Render independent top and bottom `MarketChartContainer` instances inside the existing split layout. | Ticker and benchmark/theme ETF load independently; split resizing/persistence remains unchanged. |
| 3.2 | Synchronize visible ranges by calendar date with a reentrancy guard. | Pan/zoom in either chart aligns dates in the other; missing/short history does not create feedback loops. |
| 3.3 | Synchronize crosshairs by date and target candle price. | Native axis labels align; missing target dates clear the peer crosshair; no custom values are displayed. |
| 3.4 | Persist validated Daily and Weekly `barSpacing` only. | Candle width survives ticker changes and application reload; D/W states remain independent; short-history symbols do not inherit incompatible offsets. |
| 3.5 | Preserve all TickerLens header behavior and external links; strip exchange prefixes in the client API adapter. | Yahoo receives bare symbols; benchmark/theme switching, D/W, details, and external TradingView links match the parity checklist. |
| 3.6 | Complete independent failure/loading UX and toast handling. | Either chart remains usable when its peer fails; retries and ticker changes clear only relevant errors. |

### 4 — Top-chart RS overlay

| ID | Atomic task | Completion check |
|---|---|---|
| 4.1 | Make existing RS Line and RS Trend calculations accept the requested historical range and comparison symbol. | Latest values match existing behavior; older returned dates have RS where warm-up permits. |
| 4.2 | Extend top-chart snapshots with both requested-comparison RS series. | Backend fixtures cover Daily, Weekly, warm-up, and range extension; the response identifies its comparison symbol. |
| 4.3 | Add the two-button, three-state header RS mode toggle, defaulting to RS Line with validated `localStorage` persistence. | RS, RST, and deselected states survive reload; invalid stored values fall back to RS Line. |
| 4.4 | Add the independent hidden RS scale and render the selected series in the upper 30% of the top candle pane. | Candles may overlap; no left-axis pane or custom tooltip is added. |
| 4.5 | Update RS mode/symbol/interval data without recreating either chart. | Toggle and ticker changes are immediate and free of distracting data-change animation. |
| 4.6 | Use the active bottom-chart symbol as the top RS/RST comparison. | Market/theme switching recomputes both RS modes against the displayed bottom symbol and updates only the RS series without recreating either chart. |

### 5 — Lazy historical ranges

| ID | Atomic task | Completion check |
|---|---|---|
| 5.1 | Add an initial non-persisting Yahoo historical-range fetch method. Superseded by 5.9. | Historical implementation checkpoint only. |
| 5.2 | Add backend merge/deduplication of ephemeral candle ranges with canonical candles. | Date precedence, ascending order, OHLCV validation, overlap, and empty-page fixtures pass. |
| 5.3 | Build expanded-snapshot calculation over the merged backend dataset. | Weekly aggregation, SMA/EMA, volume average, RS Line, and RS Trend are fully recalculated for the requested range. |
| 5.4 | Expose a bounded provider-neutral range contract with `has_more_before`. | Invalid bounds/limits are rejected. |
| 5.5 | Define bounded backward range expansion over the complete snapshot. | Each request expands the date span by 50% without exceeding the API bound. |
| 5.6 | Trigger TickerLens expansion only from an explicit user pan/scroll near the left edge. | Mount, resize, and right-edge movement never request lazy history; synchronized charts expand independently. |
| 5.7 | Stop backward loading when the provider reports exhaustion or returns no new candle dates. | Duplicate/stale requests are suppressed and a no-op response never calls `setData()`. |
| 5.8 | Replace all returned series while preserving the date-anchored visible logical range and bar spacing. | No viewport jump or zoom change; stale expanded snapshots cannot cross symbol/interval generations. |
| 5.9 | Make bounded and lazy history database-backed with a five-trading-session boundary overlap and remove age-based candle cleanup. | A first bounded request fetches and atomically upserts only the missing older range plus overlap; repeating it reads `daily_candles` without Yahoo; all responses remain explicitly bounded. |

### 6 — Parity approval and cutover

| ID | Atomic task | Completion check |
|---|---|---|
| 6.1 | Run backend/frontend automated checks and the full manual parity checklist on narrow/wide screens and both intervals. | All gates pass or deviations are explicitly approved. |
| 6.2 | Make Lightweight Charts the TickerLens default and remove the temporary switch after approval. | TickerLens no longer instantiates TradingView widgets; RRG and other TradingView consumers remain intact. |
| 6.3 | Remove only TickerLens-dead code/CSS/fields and update documentation. | No shared TradingView component used elsewhere is removed; worktree/build/tests are clean. |
| 6.4 | Review the complete branch and merge it to `main`. | User approves final diff and manual UI behavior before merge. |

### Future delivery — Production live charts

The POC informs this work, but none of these tasks block the historical migration.

| ID | Atomic task | Completion check |
|---|---|---|
| L.1 | Refactor Yahoo provider internals into focused chart/profile/quote/live/auth modules without extracting a crate. | Existing provider behavior and tests remain unchanged. |
| L.2 | Preserve active-session partial rows and extend quote reconciliation for provisional regular-session candles. | Review and recorded fixtures confirm live repair never fabricates missing OHLCV fields or writes provisional data. |
| L.3 | Implement the Yahoo WebSocket connection state machine and complete provisional candle snapshots. | Recorded-fixture/manual verification covers reconnect, heartbeat, and session rollover. |
| L.4 | Add symbol refcounts, five-minute symbol/connection idle deadlines, and cached current candles. | Re-subscription during grace reuses state; abnormal client disconnect releases refs. |
| L.5 | Add the 100-symbol capacity-aware LRU policy. | Idle symbols evict first; active symbols are never silently evicted; overflow reports historical-only status. |
| L.6 | Add the multiplexed application WebSocket endpoint and reconnecting frontend client. | Desired symbols restore after either connection reconnects; slow clients receive coalesced latest snapshots. |
| L.7 | Calculate provisional candles and every chart-only indicator/RS series on the backend. | Live display updates without database writes or changes to ranking/performance results. |
| L.8 | Integrate live updates with both `MarketChartContainer` instances. | Historical fallback always works; live updates are idempotent and generation-safe. |

## Verification gates

Automated checks:

- Rust formatting/build checks.
- Frontend type-check and production build.
- Pure backend calculation tests only: SMA, EMA, weekly aggregation, volume averages, RS, and candle merge/deduplication.
- No automated UI, component, endpoint, or integration tests.

Manual checks:

- Daily and Weekly visual parity.
- All requested indicators and colors.
- Ticker, benchmark, and theme switching.
- Split resizing and saved height.
- Identical candle width after ticker switch and application reload.
- Crosshair and zoom synchronization in both directions.
- RS toggle persistence, scaling, and no chart recreation.
- TickerLens backward-only lazy loading without jumps.
- Narrow and wide screens.
- User confirmation after every atomic task before proceeding.

## Rollback strategy

- Do not delete TradingView support until task 6.2 approval.
- Keep each atomic code task as a focused commit so it can be reverted independently.
- Snapshot/history API additions are additive until cutover.
- Live data is explicitly deferred and cannot block the historical Lightweight Charts migration.

## Resolved decisions

- Use an approximately 760-calendar-day initial snapshot horizon while retaining older lazily fetched candles.
- Persist lazy Yahoo history with five trading sessions of boundary overlap; no bulk preload or age-based candle cleanup.
- Synchronize charts by date.
- Use independent chart containers and robust abort/generation validation.
- Keep TickerLens lazy-loading policy outside `MarketChart`.
- RS always compares the top ticker with the active bottom-chart symbol.
- Backend computes every financial series, including lazily expanded history.
- Default to RS Line and persist the toggle.
- Omit custom chart legends/value tooltips and the current-price horizontal line.
- Use a yellow dotted volume-average line.
- Persist validated quote repair for a missing completed-session candle; keep active-session quote/live data deferred and non-persistent.
