# TickerLens Chart Parity Checklist

Use this checklist for manual comparison while TradingView and Lightweight Charts coexist. Items under “Current behavior” must remain unless explicitly listed under “Accepted changes.”

## Current behavior

### Empty and loading states

- [ ] With no ticker selected, show the group summary instead of charts.
- [ ] With no ticker selected, display `Select a ticker` in the header and disable the RS chevron.
- [ ] After selecting a ticker, show the header loading state and `Loading chart` until its chart summary is ready.
- [ ] Abort obsolete chart-summary requests when the selected ticker changes.
- [ ] Show chart/widget failures through the existing toast.

### Header identity and links

- [ ] Show `industry / ticker` identity.
- [ ] Industry opens the corresponding Market Watch view in a new tab.
- [ ] Ticker opens its TradingView symbol page in a new tab.
- [ ] Ticker hover shows company name/description when available.
- [ ] Details button opens ticker details and remains disabled without a selected ticker.
- [ ] Theme chips open their Market Watch views in new tabs.
- [ ] Multiple themes show the combined-theme link.
- [ ] Preserve ADR, extension-from-50-SMA, and average-volume summary values in the application header.

### Interval and comparison controls

- [ ] Daily and Weekly are exclusive header choices.
- [ ] Interval persists under `market-watch.chart-interval`; invalid/missing state defaults to Daily.
- [ ] Interval changes both main charts and the open standalone RS panel.
- [ ] Bottom-chart choices show the configured market benchmark plus assigned theme ETFs.
- [ ] Benchmark/theme mode persists under `market-watch.theme-etf-chart`.
- [ ] On ticker change, select the first assigned theme ETF when theme mode is enabled; otherwise use the configured market benchmark.

### Main split charts

- [ ] Top chart displays the selected ticker.
- [ ] Bottom chart displays the configured benchmark or selected theme ETF.
- [ ] Both charts fill their split slots at every panel size.
- [ ] Split defaults to 50/50 when no valid stored value exists.
- [ ] The visible divider is 1px with a larger invisible pointer hit area.
- [ ] Dragging the divider resizes both charts continuously.
- [ ] Releasing the divider persists the split under `market-watch.chart-split`.
- [ ] Current chart timezone is America/Los_Angeles and theme is dark.
- [ ] Current chart type is candlestick with volume and moving-average studies.
- [ ] Symbol/interval changes update both charts without changing the surrounding panel layout.

### Existing TradingView studies

- [ ] Simple moving average period 10 is present and blue.
- [ ] Moving-average ribbon is present.
- [ ] Chart loading background remains dark.

### Standalone RS panel regression checks

- [ ] Chevron/click and `R` toggle the panel; modified/repeated keystrokes and text controls are ignored.
- [ ] Opening slides upward and closing slides downward over the existing duration.
- [ ] Switching ticker while open keeps the panel open and updates its data.
- [ ] RS panel remains lazily loaded.
- [ ] RS height remains pointer-resizable, with the existing minimum and 90% maximum.
- [ ] RS close button, internal Daily/Weekly override, comparison tabs, pane resizing, error toast, and tooltip remain unchanged.

### Related keyboard/details behavior

- [ ] Left/Right opens ticker details according to the current navigation mode.
- [ ] Escape closes ticker details.
- [ ] Modified keys and text controls do not trigger chart-panel shortcuts.

## Required Lightweight Charts behavior

- [ ] Top and bottom data requests/loading/errors are independent.
- [ ] Daily shows SMA 10/20/50/100/200 using the approved colors.
- [ ] Weekly shows EMA 10/20/40 using blue/purple/red.
- [ ] Volume shows a yellow dotted average: 20 Daily, 5 Weekly.
- [ ] Do not show a current-price horizontal line.
- [ ] Do not show a custom top-left symbol/OHLC/return/volume/indicator legend.
- [ ] Do not show custom crosshair-updated values; keep native axis labels.
- [ ] Synchronize visible calendar dates in both directions.
- [ ] Synchronize crosshair dates in both directions.
- [ ] Persist identical candle width and right offset across ticker changes/reloads, separately for Daily and Weekly.
- [ ] Default the top overlay to RS Line versus the configured benchmark.
- [ ] Toggle between RS Line and RS Trend from the header and persist the choice.
- [ ] Constrain the RS overlay to the upper 30% of the top candle pane while allowing candle overlap.
- [ ] Lazy-load older history only on a user scroll near the left edge, without viewport jumps.
- [ ] Rapid ticker/interval changes never display stale snapshot, RS, or history results.
- [ ] Backend provides every financial series; frontend performs rendering and viewport coordination only.

## Accepted changes

- TradingView drawing tools and widget toolbar are intentionally not reproduced.
- Indicator sets change to the explicitly approved Daily SMA and Weekly EMA sets.
- Main charts gain synchronized date ranges/crosshairs, persisted viewport width, lazy history, and the RS overlay toggle.
- Production live candles are deferred; the first delivery uses historical completed candles only.

## Manual approval matrix

Run the required behavior on:

- [ ] Daily, narrow panel.
- [ ] Daily, wide panel.
- [ ] Weekly, narrow panel.
- [ ] Weekly, wide panel.
- [ ] Market benchmark selected.
- [ ] Each available theme ETF selected.
- [ ] Ticker with no themes.
- [ ] Ticker with one theme.
- [ ] Ticker with two themes.
- [ ] Rapid sequential ticker switching.
- [ ] One chart failing while the other succeeds.
