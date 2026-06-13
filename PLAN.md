# MarketWatch Page-by-Page Development Plan

## Summary

Build a local, keyboard-first market-analysis web application focused on industries, themes, tickers, and money movement.

### Stack

- Backend: Rust, Axum, SQLite
- Frontend: React, TypeScript, Vite
- Material UI v7 for shared controls and overlays; no TanStack, client cache, or global state library initially
- External data:
  - Finviz: industries and industry ticker membership
  - Yahoo Finance: ticker prices, performance, charts, and profiles
  - TradingView: fundamentals
  - AI provider: ticker-theme assignments

### UI Principles

- Dense, desktop-first, visualization-focused layout
- Use a polished, professional dark theme throughout the application
- Use the entire viewport with minimal padding and compact controls
- Prioritize space for data tables and charts over margins, padding, decoration, and navigation
- Prefer `rem` for sizing and spacing; use `px` only where fixed pixel precision is necessary
- Closed-by-default overlay navigation drawer
- No persistent header or utility bar; use a compact floating navigation trigger that overlays the workspace
- Keyboard-first navigation with centralized shortcuts
- Reusable ticker-details popup available from every page

## Shared Foundation

Complete before implementing feature pages.

### Backend

- Create Axum application, SQLite migrations, scheduler, provider clients, and local APIs.
- Keep long-lived shared resources such as configuration, SQLite store, provider clients/queues, and scheduler handles in global Axum application state.
- Keep request-specific and feature-local state outside global state.
- Keep code clean, modular, and understandable without AI assistance.
- Organize modules around clear domain responsibilities and keep provider, persistence, business logic, API, and scheduling concerns separate.
- Prefer explicit, straightforward code over clever abstractions, hidden behavior, macros, or premature generic frameworks.
- Keep functions and modules focused, use descriptive names, and document non-obvious provider behavior and architectural decisions.
- Avoid duplication where a small, concrete shared abstraction clearly improves understanding; do not generalize unrelated concepts solely to reduce line count.
- Load application settings from a TOML configuration file.
- Keep runtime-tunable values such as benchmark ticker, provider timeouts, jitter, freshness rules, and Finviz ticker filters in configuration rather than hard-coded constants.
- Centralize all external requests.
- Minimize requests using persistent caches, freshness rules, batching, and concurrent-request deduplication.
- Maintain independent request queues for Yahoo Finance, Finviz, and TradingView.
- Allow at most one in-flight request to each provider; different providers may run concurrently.
- Apply explicit bounded connection and overall-operation timeouts to every external request.
- Add provider-specific jittered delays, bounded retries, and stale-data fallback.
- Pages call only local Axum APIs.

### Industry Data

- Scrape complete Finviz industry rows daily.
- Preserve historical snapshots by local date.
- Treat industry data as stale only on a US trading day after 1:20 PM Pacific when no successful Finviz snapshot exists for that date.
- Before 1:20 PM Pacific, on weekends, and on US market holidays, continue using the latest trading-day snapshot.
- On startup, scrape only when industry data is stale.
- Make at most one successful Finviz industry snapshot request per trading day, excluding retries.
- Retry failed scheduled scrapes up to three times.
- Lazily fetch industry ticker membership from Finviz using predefined filters loaded from the TOML configuration.
- Cache the resulting filtered ticker membership for 30 days.

### Ticker Data

- Treat Yahoo Finance price history as stale only on a US trading day after 1:20 PM Pacific when no successful refresh exists for that date.
- Before 1:20 PM Pacific, on weekends, and on US market holidays, continue using the latest available price history.
- Fetch Yahoo Finance price history only when missing or stale, and make at most one successful refresh per ticker per trading day.
- Use Yahoo Finance responses as the source of ticker exchange metadata because Finviz screener rows do not expose exchange information.
- Persist the Yahoo-compatible ticker as the canonical identifier and store exchange metadata separately when available.
- Populate exchange metadata during existing Yahoo price/profile requests; do not make a separate request solely for exchange lookup.
- Calculate `1W`, `1M`, `3M`, `6M`, `1Y`, and ticker RS locally.
- Fetch Yahoo company profiles lazily.
- Fetch TradingView fundamentals lazily.
- Persist all reusable data in SQLite.

### Shared Frontend

- Full-viewport application shell, floating navigation trigger, overlay navigation drawer, and routing.
- Use a centralized dense dark Material UI theme and shared MUI components for controls, forms, feedback, and overlays.
- Reuse styling through theme tokens, global component overrides, and shared semantic classes or components; keep component-local `sx` limited to genuinely unique styling.
- Avoid duplicated colors, spacing, typography, and unnecessary `!important` overrides.
- Keep data-dense layouts, keyboard-navigable market lists, charts, and visualizations as focused custom components.
- Avoid MUI X paid components unless their licensing and value are explicitly reviewed.
- Typed local API client using native `fetch`.
- Reusable list, sorting controls, RS chip, chart workspace, loading/error state, and ticker popup.
- Central keyboard-shortcut system and shortcut-reference dialog.
- Preserve focus and selection while moving between lists, charts, and popups.

### Relative Strength

- Use `QQQ` as the default configurable benchmark.
- Calculate benchmark-relative return for each period:

```text
relative_return = ((1 + asset_return) / (1 + benchmark_return)) - 1
```

- Calculate one absolute RS value consistently for industries, themes, and tickers:

```text
RS = 100 × (
  0.10 × relative_1W +
  0.30 × relative_1M +
  0.30 × relative_3M +
  0.15 × relative_6M +
  0.15 × relative_1Y
)
```

- Treat a missing period as zero relative return; do not redistribute its weight.
- Do not use percentile ranking, so a ticker has the same RS regardless of which industry, theme, or collection displays it.
- Initially display signed numeric RS values using neutral chips.
- Keep chip color thresholds centralized and defer tuning until real RS distributions are available.

## Page 1: Market Watch

Primary daily-use page.

### Layout

```text
| Industries / Themes | Tickers | Chart |
```

- Toggle between industry and theme modes.
- Left panel lists industries or themes.
- Middle panel lists tickers belonging to the selected group.
- Right panel displays the selected group or ticker chart.
- Panels use all available workspace and may become resizable later.

### Industries

- Read latest industry data from SQLite.
- Sort by `1W`, `1M`, `3M`, `6M`, `1Y`, or RS.
- Default sort: descending RS.
- Display RS chips.
- Lazily load ticker membership when selected.

### Themes

- Maintain approximately 50 major themes mapped to representative ETFs.
- Rank themes using ETF performance and RS.
- Display AI-assigned theme tickers.
- Use the same sorting, list, chart, and keyboard behaviors as industries.

### Tickers

- Sort by `1W`, `1M`, `3M`, `6M`, `1Y`, or RS.
- Default sort: descending RS.
- Display RS chips.
- Keyboard navigation moves through tickers and updates the chart.
- Open ticker-details popup from the selected ticker.

### Acceptance

- Page uses the full available viewport.
- Repeated navigation does not generate unnecessary external requests.
- Industry/theme and ticker lists are fully keyboard navigable.
- Cached or stale data remains usable when providers fail.

## Page 2: Trend Analyzer

Analyze money movement across industries and themes.

### Layout

- Dataset toggle: `Industries | Themes`
- Visualization tabs: `RRG | Bump Chart`
- Compact filter toolbar
- Main visualization fills remaining viewport

### RRG

- Show leadership, weakening, lagging, and improving movement.
- Support keyboard selection and trail inspection.
- Selecting a group opens its details or corresponding Market Watch context.

### Bump Chart

- Show rank changes over historical snapshots.
- Support industries and themes.
- Highlight selected groups and movement changes.

### Filters

- Remove slow-moving, lagging, or irrelevant groups.
- Keep filters compact and keyboard accessible.
- Calculate visualizations entirely from persisted local history.

### Acceptance

- Switching datasets, tabs, and filters makes no external requests.
- Visualizations remain usable with incomplete historical data.
- Keyboard users can select and inspect every visible group.

## Page 3: CSV Analyzer

Analyze arbitrary ticker collections similarly to StockThemes.

### Capabilities

- Upload or select a CSV containing tickers.
- Validate and normalize ticker symbols.
- Reuse cached Yahoo performance, RS, charts, AI theme assignments, and ticker popup.
- Fetch only missing or stale ticker data.
- Provide sortable ticker lists and visualization workspace.
- Support future RRG and grouping analysis without creating separate domain logic.

### Acceptance

- Reanalyzing the same ticker collection reuses persisted data.
- Invalid or unsupported tickers are reported without blocking valid tickers.
- Core workflow is keyboard accessible.

## Page 4: Theme Management

Manage themes, ETF mappings, and ticker-theme assignments.

### Theme Management

- Create, rename, and remove themes.
- Add or remove representative ETFs.
- Review theme performance and assigned tickers.

### Ticker Assignments

- AI assigns each ticker to zero, one, or at most two themes.
- Persist AI reasoning, inputs, model metadata, and assignment date.
- Skip reclassification when inputs have not changed.
- Review and manually override assignments.
- Manual overrides remain authoritative until explicitly removed.

### Acceptance

- Theme and ETF changes appear on Market Watch and Trend Analyzer.
- No ticker can have more than two active themes.
- AI classification does not repeat unnecessarily.
- Manual overrides are preserved.

## Reusable Ticker Popup

Available from Market Watch, Trend Analyzer, CSV Analyzer, and Theme Management.

Display:

- Price and performance chart
- Period returns and RS chip
- Yahoo Finance company profile
- TradingView fundamental charts
- Industry membership
- Assigned themes and AI reasoning

Behavior:

- Open and navigate using the keyboard.
- Support previous/next ticker navigation.
- Fetch expensive details lazily.
- Reopening fresh details creates no external requests.
- Serve stale cached details if refresh fails.

## Development Sequence

1. Shared backend, persistence, provider clients, request policy, and application shell.
2. Market Watch in industry mode.
3. Market Watch theme mode and AI assignments.
4. Reusable ticker popup.
5. Trend Analyzer.
6. CSV Analyzer.
7. Theme Management.

Each page is completed, tested, and reviewed before starting the next page. Open formulas and visualization details are decided only when their page becomes active.

## Current Status

Completed:

- Rust/Axum server, SQLite connection and migrations, validated TOML configuration, tracing, graceful shutdown, and local API routing.
- Serialized Finviz client for industry performance, filtered industry membership, and ticker-industry lookup.
- Daily persisted Finviz industry snapshots with market-close freshness scheduling.
- Generic Yahoo chart/profile client with serialized requests, cookie/crumb handling, typed retryable errors, jittered exponential retries, and exchange normalization.
- Persistence-backed Yahoo service with profiles, daily candles, forward-only refresh with overlap, per-symbol request deduplication, and market-close-plus-five-minute freshness.
- Shared market schedule, exchange, candle, profile, performance, and RS domain models.
- Latest-industry API with QQQ benchmark-relative RS calculated at read time.
- React/Material UI shell with draggable navigation trigger, overlay drawer, reusable toast, and three-panel Market Watch workspace.
- Market Watch industry ranked list with multi-selection, persisted sort key/direction, selectable RS/performance metrics, and dynamic min/max metric coloring.
- Backend tests/clippy and frontend type-check/build pass without warning suppressions.

Next implementation slice:

1. Persist filtered Finviz industry ticker membership with the configured freshness period.
2. Add an API that returns the combined deduplicated ticker set for selected industry keys.
3. Populate the Market Watch ticker panel from selected industries.
4. Add ticker selection, sorting, loading/error states, and request deduplication.
5. Calculate and display ticker performance and RS using the persisted Yahoo daily candles.

Every implementation review must also confirm that:

- New behavior has an obvious owning module.
- External-provider behavior and cache/freshness rules are discoverable from code and configuration.
- Public types and APIs have clear names and minimal responsibilities.
- Tests explain important behavior without requiring knowledge of implementation details.
- A developer can modify one feature without understanding or changing unrelated subsystems.

## Verification

- Fixture-based Finviz and TradingView parser tests.
- Historical snapshot and non-overwrite tests.
- Cache, request-deduplication, jitter, retry, and stale-fallback tests.
- Yahoo performance and RS calculation tests.
- AI assignment and two-theme-limit tests.
- Keyboard-navigation tests for every page and popup.
- Integration tests proving repeated navigation avoids redundant external requests.
- Visual checks for dense full-viewport layouts.

## Deferred Decisions

Decide immediately before the relevant page is implemented:

- Validate historical return cutoffs by accepting the latest candle on or before each target date only when it is within an agreed maximum calendar-day distance; otherwise treat the period as missing and return zero. Do not use a minimum candle-count requirement because newly listed tickers legitimately have shorter histories.
- Theme catalog and multi-ETF aggregation
- AI provider, prompt, and reclassification policy
- RRG benchmark, formula, trails, and filters
- Bump-chart ranking metric and history range
- CSV input format details
- Exact chart library and chart interactions

## Assumptions

- Local, single-user, desktop-focused, internet-dependent application
- SQLite is the authoritative cache and historical store
- Backend owns all caching and external-provider access
- Best-effort collection and stale-data fallback are preferred over aggressive requests
- Mobile support is not an initial requirement
