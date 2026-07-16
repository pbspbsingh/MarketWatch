# TickerLens Lightweight Charts Migration Plan

Status: Active

Implementation branch: `feature/lightweight-ticker-lens-charts`

Merge target: `main` only after manual parity approval

Current checkpoint: task 4.2 implemented and reviewed; awaiting commit approval. Top-chart snapshot and history requests now include both configured-benchmark RS series; bottom-chart requests remain RS-free.

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
- The top chart can display either RS Line or RS Trend in the upper 30% of the candle pane, selected from the existing header.
- RS Line is the default; persist the selected RS mode.
- Do not render a current-price horizontal line.
- Do not render a top-left symbol/OHLC/return/volume/indicator legend or crosshair-updated values. Keep native crosshair axis labels.
- Persist approximately 500 completed daily candles per symbol after a one-time candle-table purge.
- Fetch additional history lazily from Yahoo without saving it to the database: backward-only for TickerLens and bidirectional for Studies.
- Compute candles, Daily/Weekly aggregation, all moving averages, volume averages, RS Line, and RS Trend on the backend. The frontend renders returned series and performs no financial calculations.
- Live quote/WebSocket data is chart presentation data only. It must not affect persistence, RS/AS, sorting, summaries, notes, or any other analytical flow.

## Accepted parity boundary

Lightweight Charts provides candles, series, panes, scales, pan/zoom, crosshair control, and realtime updates. It does not provide the complete TradingView widget toolbar, drawing suite, or built-in indicator configuration UI.

The TradingView widget toolbar and drawing tools are explicitly not required and will not be recreated. “No noticeable difference” applies to the TickerLens chart workflow, controls, indicators, layout, and interactions defined in this plan.

## Architecture

```text
Yahoo chart API ──> persisted completed candles ──> chart snapshot API ──> MarketChart
       │
       └──────────> ephemeral candle ranges ─────> history API ────────> merge

Yahoo quote API ──> current-session snapshot ─┐
Yahoo WebSocket ──> live ticks ───────────────┼─> LiveChartManager ─> app WebSocket ─> series.update()
                                              └─> memory only
```

### Ownership boundaries

- `YahooClient`: Yahoo protocol, decoding, throttling, and provider errors.
- Historical candle service: persisted recent range plus explicitly non-persisting supplemental range fetches.
- Backend chart calculation module: Daily/Weekly aggregation, SMA/EMA, volume averages, RS Line, and RS Trend.
- `LiveChartManager` (deferred): Yahoo WebSocket lifecycle, quote reconciliation, subscriptions, and provisional candles.
- Chart API: provider-independent snapshot, history, and live message contracts.
- `MarketChartContainer`: one symbol's independent snapshot/history request, cancellation, generation, and error state.
- Study history controller: coordinated two-symbol range requests and bidirectional availability.
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

Build TickerLens on this foundation first. Migrate `StudyCharts` in the focused bidirectional-history tasks below; migrate `RsChartView` later only where it removes real duplication without changing behavior.

## Data contracts

### Initial chart snapshot

Add a chart-snapshot endpoint requested independently by each `MarketChartContainer`. It returns interval-specific candles and every fully calculated chart series for one symbol. The top-chart request also asks for both RS modes against the configured market benchmark.

Each response includes:

- Symbol.
- Bare provider symbol. Exchange/display identifiers remain owned by the existing chart summary contract.
- Ordered Daily or Weekly OHLCV candles.
- SMA/EMA series and volume-average series required for the interval.
- Optional RS Line and RS Trend series for the top chart.
- Earliest and latest available dates.
- Whether additional history may exist before and after the returned range.
- Per-symbol error information; one chart's failure must not remove the other chart.

### Lazy historical range

Add a separate endpoint with a provider-neutral contract. It returns a complete recalculated chart snapshot for the requested expanded range, not only raw candles, because changing the range can change indicator values.

- `symbol`
- interval and configured benchmark when RS is requested
- requested start/end boundaries or candle targets
- ordered candles and all recalculated indicator/RS series
- `has_more_before` and `has_more_after`

TickerLens combines persisted recent candles with Yahoo-fetched older candles without saving the older range; its `has_more_after` is always false because its range ends at the latest completed session. Studies uses the same range-fetch foundation without persistence and may expand in either direction around its selected historical date, never beyond the latest completed session. A Study expansion reloads both displayed symbols together so synchronized date coverage remains stable.

This path must retain the existing provider concurrency limit, retry policy, and error mapping. Concurrent duplicate requests for the same symbol/range should be coalesced only while in flight; no historical cache is required. Re-requesting data is acceptable.

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

The working target is approximately 500 trading candles. Implement this using an approximately 760-calendar-day retained/requested range; exact session counts vary by holidays and listings.

- Change the recent-candle horizon only when the new chart endpoint is ready.
- Do not purge during ordinary startup or schema migration.
- At cutover, run one explicit, user-approved purge of `daily_candles` so the existing fetch flow repopulates the expanded range cleanly.
- Keep the purge out of application code and out of automatic migrations.
- Do not persist lazy history.
- After the purge, preserve the current on-demand population behavior; do not add a bulk preload job.
- The expanded global range is acceptable for existing analytical flows.

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

Use the retained approximately two-year snapshot for initial rendering. Do not fetch lazy history on mount or container resize. Request older history only after an explicit user pan/scroll reaches the left edge; synchronized chart instances expand independently from the same interaction.

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
- Candle, volume, grid, scale, and line-width defaults follow the existing Studies chart and the supplied screenshot.

### Candle merge and indicator updates

The backend maintains one ordered collection for each request, keyed by market date. Data precedence is:

1. Provisional live candle for the current session.
2. Persisted finalized snapshot candle.
3. Ephemeral lazy-range candle.

Lazy ranges must merge by date, deduplicate, validate OHLCV, sort ascending, aggregate the requested interval, and recompute all returned series on the backend. Before requesting an expanded snapshot, the frontend captures the visible date range and viewport settings. After replacing series data, it restores the same viewport so candles do not jump.

The frontend replaces data on existing candle/volume/indicator series; it never recreates the chart. Full backend recomputation is intentional: the dataset is small, and prepending history can change the EMA seed and therefore every later Weekly EMA value.

## RS overlay

- Reuse the existing backend RS Line and RS Trend formulas; do not create parallel formulas in the frontend.
- Compare the top ticker against the configured market benchmark, regardless of the symbol displayed in the bottom chart.
- Return RS across lazily loaded history as part of each complete backend snapshot.
- Preserve RS Line's current latest-12-month geometric-mean normalization anchor and apply that fixed anchor to older returned ratios. Expanding history must not rescale or change already visible recent RS values.
- Render on an independent left scale constrained to the upper 30% of the top candle pane; candles may overlap it.
- Header toggle: `RS Line | RS Trend`; default to RS Line and persist the preference.
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

- [x] 0.1 — Branch, plan, and reference screenshot.
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
- [x] 4.2 — Opt-in top-chart snapshots with configured-benchmark RS Line and RS Trend.
- [x] 5.1 — Non-persisting Yahoo historical-range fetch.
- [x] 5.2 — Date-keyed persisted/ephemeral merge with canonical precedence.
- [x] 5.3 — Expanded candles and all backend series, including RS, are recomputed over merged history.
- [x] 5.4 — Bounded provider-neutral history contract and availability flags.
- [x] 5.5 — Bounded 50% backward range expansion.
- [x] 5.6 — User-scroll-only TickerLens history trigger.
- [x] 5.7 — Terminal/no-new-candle handling without `setData()`.
- [x] 5.8 — Date-anchored logical viewport preservation and stale-response rejection.

### 0 — Establish the branch and de-risk Yahoo live access

| ID | Atomic task | Completion check |
|---|---|---|
| 0.1 | Create `feature/lightweight-ticker-lens-charts`; add this plan and the reference screenshot. | Branch starts from current `main`; planning artifacts are committed; worktree is clean. |
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
| 1.7 | Change retained/requested history from 380 to approximately 760 calendar days. | Existing analytical flows still pass; maintenance uses the same new horizon; no purge runs automatically. |

### 2 — Shared Lightweight Charts foundation and one chart

| ID | Atomic task | Completion check |
|---|---|---|
| 2.1 | Add shared chart options and time/date helpers using Studies styling and the reference screenshot. | No feature behavior changes; shared constants cover candles, volume, grid, scales, and indicator colors. |
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
| 4.1 | Make existing RS Line and RS Trend calculations accept the requested historical range while keeping the configured benchmark. | Latest values match existing behavior; older returned dates have RS where warm-up permits. |
| 4.2 | Extend top-chart snapshots with both configured-benchmark RS series. | Backend fixtures cover Daily, Weekly, warm-up, and range extension; bottom symbol does not affect comparison. |
| 4.3 | Add the header RS mode toggle, defaulting to RS Line with validated `localStorage` persistence. | Preference survives reload and invalid stored values fall back to RS Line. |
| 4.4 | Add the independent RS scale and render the selected series in the upper 30% of the top candle pane. | Candles may overlap; labels do not cover chart content; no custom tooltip is added. |
| 4.5 | Update RS mode/symbol/interval data without recreating either chart. | Toggle and ticker changes are immediate and free of distracting data-change animation. |

### 5 — Non-persisted lazy ranges and Studies reuse

| ID | Atomic task | Completion check |
|---|---|---|
| 5.1 | Add a Yahoo historical-range fetch method that bypasses candle persistence while reusing throttling/retry/error behavior. | Code review confirms the method has no store dependency/write path; format/build checks pass. |
| 5.2 | Add backend merge/deduplication of ephemeral candle ranges with canonical candles. | Date precedence, ascending order, OHLCV validation, overlap, and empty-page fixtures pass. |
| 5.3 | Build expanded-snapshot calculation over the merged backend dataset. | Weekly aggregation, SMA/EMA, volume average, RS Line, and RS Trend are fully recalculated for the requested range. |
| 5.4 | Expose a bounded provider-neutral range contract with `has_more_before` and `has_more_after`. | TickerLens always reports no forward range; Study ranges stop at the latest completed session; invalid bounds/limits are rejected. |
| 5.5 | Define bounded backward range expansion over the complete snapshot. | Each request expands the date span by 50% without exceeding the API bound. |
| 5.6 | Trigger TickerLens expansion only from an explicit user pan/scroll near the left edge. | Mount, resize, and right-edge movement never request lazy history; synchronized charts expand independently. |
| 5.7 | Stop backward loading when the provider reports exhaustion or returns no new candle dates. | Duplicate/stale requests are suppressed and a no-op response never calls `setData()`. |
| 5.8 | Replace all returned series while preserving the date-anchored visible logical range and bar spacing. | No viewport jump or zoom change; stale expanded snapshots cannot cross symbol/interval generations. |
| 5.9 | Extend the Study service/API with bounded start/end ranges and bidirectional availability for both symbols. | Expansions remain non-persisted, reload both symbols together, and never cross the latest completed session. |
| 5.10 | Add a Study history controller that requests backward or forward expansion near either visible edge. | Directional requests are deduplicated/abortable and stop independently when the corresponding availability flag is false. |
| 5.11 | Replace Study chart internals with two shared `MarketChart` instances and shared date synchronization. | Existing selected-date marker, layout toggle, visibility toggle, crosshair sync, and initial viewport remain manually equivalent. |
| 5.12 | Preserve the Study viewport while merging bidirectional expansions. | Either direction adds candles without jumping the selected date or changing the visible candle width. |

### 6 — Data reset, parity approval, and cutover

| ID | Atomic task | Completion check |
|---|---|---|
| 6.1 | Request explicit approval, then purge `daily_candles` once and allow current on-demand population to rebuild it. | No automatic purge code exists; accessed symbols populate the approximately 760-day range. |
| 6.2 | Run backend/frontend automated checks and the full manual parity checklist on narrow/wide screens and both intervals. | All gates pass or deviations are explicitly approved. |
| 6.3 | Make Lightweight Charts the TickerLens default and remove the temporary switch after approval. | TickerLens no longer instantiates TradingView widgets; RRG and other TradingView consumers remain intact. |
| 6.4 | Remove only TickerLens-dead code/CSS/fields and update documentation. | No shared TradingView component used elsewhere is removed; worktree/build/tests are clean. |
| 6.5 | Review the complete branch and merge it to `main`. | User approves final diff and manual UI behavior before merge. |

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
- TickerLens backward-only and Studies bidirectional lazy loading without jumps.
- Narrow and wide screens.
- User confirmation after every atomic task before proceeding.

## Rollback strategy

- Do not delete TradingView support until task 6.3 approval.
- Keep each atomic code task as a focused commit so it can be reverted independently.
- Snapshot/history API additions are additive until cutover.
- The one-time candle purge contains no irreplaceable data; Yahoo repopulates completed candles. Still require explicit confirmation immediately before executing it.
- Live data is explicitly deferred and cannot block the historical Lightweight Charts migration.

## Resolved decisions

- Use an approximately 760-calendar-day global persisted horizon and accept the additional local analytical load.
- Preserve existing on-demand population after the explicit purge; no bulk preload.
- Synchronize charts by date.
- Use independent chart containers and robust abort/generation validation.
- Keep lazy direction policy outside `MarketChart`: TickerLens loads backward only; Studies loads both directions for both symbols together.
- RS always compares the top ticker with the configured market benchmark.
- Backend computes every financial series, including lazily expanded history.
- Default to RS Line and persist the toggle.
- Omit custom chart legends/value tooltips and the current-price horizontal line.
- Use a yellow dotted volume-average line.
- Persist validated quote repair for a missing completed-session candle; keep active-session quote/live data deferred and non-persistent.
