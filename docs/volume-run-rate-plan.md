# Volume Run Rate (VRR) Plan

Status: Implementation underway; live Yahoo session-transition semantics still
require market-hours verification.

## Objective

Display a live `VRR 1.3x` label beside the existing `RS` control on each
lightweight chart.

VRR compares today's cumulative volume with normal cumulative volume at the
same configured market-local time. Premarket, regular-market, and postmarket
volume form one continuous day; the calculation does not classify or reset by
session.

## Metric contract

For configured market-local time `t`:

```text
actual(t)   = today's cumulative volume through t
expected(t) = average historical cumulative volume through t
VRR(t)      = actual(t) / expected(t)
```

Rules:

- Use Yahoo five-minute candles with `includePrePost=true`.
- Use the latest 20 completed trading dates by default.
- Exclude the current market date from its baseline.
- Map UTC candle timestamps through the existing configured market timezone.
  Do not hardcode Eastern Time.
- Missing historical buckets contribute zero incremental volume.
- Prorate the expected volume for the active five-minute bucket by elapsed
  time, avoiding a dip at each bucket boundary.
- Return unavailable when 20 complete dates cannot be formed or expected
  cumulative volume is zero. Do not clamp valid ratios.
- Format the UI value to one decimal place.

## Storage decision

Do not persist five-minute candles or derived volume profiles in the database.

Measured release-mode Yahoo fetches for SPY, without the client's intentional
request delay, were:

- One day: 190 candles in approximately 248 ms.
- One month: 3,781 candles in approximately 322 ms.

The monthly response returned about 20 times as many candles for only about 30%
more latency in this sample. Network measurements vary, but this is fast enough
to favor a simpler on-demand fetch and memory cache over migrations, backfill,
coverage tracking, and database retention.

Reconsider persistence only if production measurements show unacceptable Yahoo
rate limiting, startup latency, or repeated cross-process fetch cost, or if a
future intraday-chart requirement needs history beyond Yahoo's available range.

## Scope

Included:

- One 35-day Yahoo bootstrap request on the first live subscription for a
  symbol and configured market date, regardless of which feature subscribed.
- Current-day-only reseeding after that symbol's live state expires.
- In-memory caching of the fetched five-minute OHLCV candles and derived
  cumulative-volume profile.
- Live cumulative-volume normalization and VRR calculation.
- VRR delivery through the existing market-chart WebSocket.
- A read-only label beside `RS` on each lightweight chart.

Deferred:

- A five-minute candle overlay. Its future endpoint may reuse the cached full
  OHLCV response; persistence should be decided from that feature's measured
  retention requirements.
- Other intraday intervals.
- VRR sorting or filtering in ticker lists.
- TradingView-embedded chart integration.

## Historical fetch and profile

Add pure `VolumeProfile` construction and VRR calculation functions under
`models`. `YahooService` exposes the retry-enabled five-minute range operation;
API code must not call `YahooClient` directly. `YahooLiveActor` owns profile
storage and bootstrap selection.

On the first live subscription for a symbol and configured market date:

1. Resolve the canonical ticker to `YahooSymbol`.
2. Use `MarketSchedule` to generate the latest 20 trading dates strictly before
   the current configured market date.
3. Fetch a single range covering those dates through the current time—normally
   about 35 calendar days—with `includePrePost=true`, remaining within Yahoo's
   intraday history window.
4. Convert each UTC timestamp to a configured-local market date and five-minute
   bucket through `MarketSchedule`; reject malformed or out-of-range candles.
5. Verify all 20 scheduled dates are within both the fetched range and the
   symbol's Yahoo `firstTradeDate`. Otherwise return unavailable.
6. Build cumulative volume for every scheduled date. A date or bucket with no
   candle contributes zero; do not silently replace it with an older date.
7. Average each cumulative bucket across the same 20 dates.
8. From the same response, aggregate current-date candles into the premarket,
   regular-market, and postmarket seed required by `YahooLiveActor`.
9. Cache the historical OHLCV portion and derived profile, then return the live
   seed to the actor. Do not cache current-day candles as historical truth.

Profile shape:

- Key buckets by configured market-local `HH:MM`, not UTC time, so equivalent
  buckets remain aligned across daylight-saving changes.
- Missing buckets add zero and retain the prior cumulative total.
- Record the baseline cutoff date and source dates for validation.

Cache policy:

- Key by `(symbol, current configured market date, session count)`. The profile
  always ends at the previous completed trading date, so it remains stable
  throughout premarket, regular market, and postmarket.
- Keep only the current profile version for each symbol.
- Use a small private bounded cache so symbols visited during the day cannot
  grow memory indefinitely. Align its initial capacity with the actor's
  100-symbol limit and keep eviction bookkeeping inside the actor.
- Rely on actor serialization and the existing per-symbol `seed_tasks`; do not
  add cache locks or a second request-coalescing mechanism.
- Keep this cache independent from the live actor's five-minute idle grace.
  Reopening an expired live subscription reuses the historical profile.
- Never evict a profile while its symbol is active or in the idle grace period;
  evict the least-recently-used unwatched profile instead.
- A process restart or capacity eviction may refetch once; that is accepted.
- Do not cache failures beyond a short retry backoff.

The cache retains the historical OHLCV portion as well as the much smaller
derived profile. A future five-minute overlay may reuse that history;
current-day candles remain a point-in-time seed and must be refreshed.

## Fit with the current Yahoo subscription model

Keep the existing single application-wide `YahooLiveActor`; do not open a
second Yahoo WebSocket for VRR.

Current behavior to preserve:

- Subscriptions are reference-counted by Yahoo symbol and shared across API
  clients.
- The actor supports at most 100 active or idle symbols.
- After the final subscriber leaves, Yahoo streaming and live caches remain for
  a five-minute grace period. At expiry, the actor unsubscribes and removes the
  symbol's live state.
- Each market-chart socket flattens primary and relative-strength comparison
  symbols into Yahoo subscriptions and forwards the latest watched state.
- Regular updates trigger calculated chart deltas; premarket and postmarket
  updates use separate session deltas.

VRR integration:

- Keep a distinct internal live-volume value containing market date,
  normalized full-day cumulative volume, and update timestamp.
- Add the calculated result to `YahooLiveState` and expose it as
  `YahooLiveUpdate::VolumeRunRate`, containing symbol, market date, update
  timestamp, and `Option<f64>`. Latest-value coalescing is appropriate; VRR
  does not require every provider tick.
- Maintain the normalized live-volume state inside `YahooLiveActor`, where
  each Yahoo frame is processed once. Do not normalize separately per browser
  or WebSocket.
- Keep the regular daily candle's volume unchanged. Full extended-hours volume
  is a separate value and must not alter existing daily-chart semantics.
- Extend the existing intraday seed to retain postmarket volume, not only its
  last price, so a new or resumed subscription can reconstruct today's total.
- Every newly watched symbol uses the same bootstrap path. The actor asks
  `YahooService` for a retry-enabled range and derives both the profile and
  today's session seed; subscription callers do not declare feature-specific
  intent.
- Profiles may therefore be prepared for Theme Tracker and RS-comparison
  symbols, but only primary market-chart symbols produce VRR events.
- If the profile is already cached but live state has expired, use the existing
  current-day seed request instead of fetching 35 days again.

The live actor's five-minute expiry removes only current-day live volume. Its
historical profile remains available for resubscription during the same market
day. A later subscription therefore reseeds today's volume but normally avoids
another monthly history request.

At configured market close plus the existing four-hour postmarket window, the
actor enters `Closed` within its existing 15-second schedule-check interval,
removes all desired Yahoo transport subscriptions, aborts pending
seed/bootstrap work, and clears current live-volume state. It must publish an
explicit volume-cleared update so charts render `VRR —` instead of retaining
the final ratio. Historical profiles are also cleared because the next market
day requires a new baseline. Existing chart subscribers are resubscribed and
bootstrapped when the next live window begins.

Consequently, the normal request pattern per symbol and configured market date
is:

- First subscription from any feature: one 35-day bootstrap request.
- Resubscription while live state is retained: no seed request.
- Resubscription after five-minute live expiry: one current-day seed request.
- Profile eviction before resubscription: one new 35-day bootstrap request.

This intentionally trades provider traffic for one uniform subscription path.
Theme Tracker can request up to 100 symbols, so a cold cache may enqueue up to
one 35-day request per symbol. The existing Yahoo single-request permit, pacing,
and retries remain authoritative; do not add parallel bootstrap traffic. A
later market chart for any of those symbols reuses both live state and profile.

## Live numerator

The numerator remains cumulative across the entire extended-hours day and must
not reset at premarket, regular-market, or postmarket boundaries.

Normalization rules:

- Maintain one normalized cumulative volume and high-water timestamp per
  symbol and configured market date inside `YahooLiveActor`.
- Never calculate or publish a numeric VRR while `MarketSchedule` reports
  `Closed`.
- Use the seed observation timestamp, rather than the latest candle's bucket
  start, when calculating the initial denominator.
- Use ordered Yahoo live frames for the current total. At the first frame of
  each provider phase, compare full-day and session-local interpretations with
  the seeded/current total and retain the closest interpretation for that
  phase. This supports either Yahoo behavior without double-counting.
- Seed the total from today's premarket, regular, and postmarket five-minute
  aggregates when a symbol is newly subscribed after its live cache expired.
  Across a transport reconnect, retain actor state and reconcile it from the
  next cumulative provider frame.
- Retain and normalize postmarket `day_volume`; postmarket price publication
  remains a separate existing contract.
- Reject delayed frames using the existing per-symbol high-water mark.
- Never synthesize authoritative OHLCV candles from live frames.
- Continue using session classification only to validate Yahoo frames and
  normalize any provider reset. Session boundaries never reset the VRR metric.

VRR may retain the last observed ratio through the remainder of the postmarket
window. At `Closed`, or before the first expected bucket, display unavailable.

## Ownership and code structure

`YahooLiveActor` responsibilities:

- Own current-day normalized cumulative volume and its timestamp.
- Own the bounded `VolumeProfile` cache; mutate it only on the actor loop.
- Seed it when a live subscription starts or resumes after eviction. A
  transport reconnect retains actor state and reconciles from the next
  cumulative provider frame; it does not require another history request.
- Choose a 35-day bootstrap on profile miss and the existing current-day seed
  on profile hit.
- Publish `YahooLiveUpdate::VolumeRunRate` on the existing shared subscription.
- Publish an explicit volume-cleared update when the actor transitions to
  `Closed`, allowing consumers to clear a previously displayed VRR.

Pure model responsibilities:

- Build `VolumeProfile` from validated candles and scheduled dates.
- Aggregate today's candles into the existing session-seed shape.
- Calculate expected cumulative volume and VRR without I/O or shared state.
- Keep profile insufficiency separate from seed validity: a valid current-day
  seed must still be returned when fewer than 20 historical dates are usable.

Integration:

- Keep one feature-neutral live subscribe command. The actor starts
  bootstrap work asynchronously for every newly watched symbol; its existing
  `seed_tasks` map prevents duplicate work for a symbol.
- Continue live price delivery while the profile loads.
- Respect the existing Yahoo concurrency permit, pacing, and retries.
- Keep the WebSocket handler limited to mapping actor updates to current chart
  IDs and serialization; it does not fetch, cache, or calculate VRR.

## API contract

Add a dedicated event to the existing market-chart WebSocket:

```text
{
  "type": "volume_run_rate",
  "request_id": 7,
  "delta": {
    "chart_id": "top",
    "symbol": "AAPL",
    "value": 1.3
  }
}
```

- `value: null` means loading, insufficient history, invalid live volume, or a
  recoverable provider failure.
- A transition to `Closed` must emit `value: null`; the last postmarket value
  must not remain sticky in the UI.
- Do not add VRR to regular `LiveChartDelta` or `LiveSessionDelta`; VRR spans
  all provider phases and must update independently of chart-candle updates.
- Reuse the existing 250 ms debounce.
- The actor publishes the latest calculated VRR. The socket handler maps that
  symbol update only to primary charts and does not inspect profiles or raw
  volume. Bootstrap completion publishes the seeded VRR so the first value does
  not depend on a later Yahoo tick.
- Stamp every event with the current `request_id`; the client must reject
  results for an old chart selection.
- Validate `value` client-side as `null` or a finite non-negative number.
- Do not send the profile or candle history over the live event.

## UI

The lightweight `MarketChart` owns this overlay because it already owns `RS`.

- Render a non-interactive `VRR 1.3x` label in the same overlay group beside
  `RS`.
- Each chart displays VRR for its own symbol.
- If `RS` is absent, VRR keeps the same anchor instead of depending on the RS
  control.
- Render `VRR —` until a valid value arrives.
- Use neutral styling; do not invent bullish/bearish thresholds.
- Add an accessible label such as `Volume run rate 1.3 times`.
- Preserve the RS button's independent toggle behavior.
- Clear the displayed value when the chart's symbol/request changes; accept
  events only for the current `request_id`, `chart_id`, and symbol.

## Configuration

Add one validated market setting:

```text
volume_run_rate_sessions = 20
```

Update real and example configuration. Do not reuse
`average_volume_sessions`; daily average volume and intraday profile sampling
are separate policies.

Use the existing configured timezone, market hours, holidays, and
`MarketSchedule`. No new timezone or session configuration is needed.

## Delivery phases

1. **Pure profile model and Yahoo range operation**
   - Configured-local bucketing, cumulative profile and VRR tests, plus one
     retry-enabled service method for five-minute ranges.
2. **Live-volume verification**
   - Observe Yahoo transitions, document semantics, retain postmarket volume,
     and normalize cumulative volume inside the existing live actor.
3. **Subscription and API integration**
   - Add the actor-owned bounded profile cache, bootstrap selection, publish
     `YahooLiveUpdate::VolumeRunRate`, and add its dedicated nullable event to
     the existing chart WebSocket.
4. **Calculation and chart overlay**
   - Calculate the ratio and add the label beside RS for both lightweight
     charts.
5. **Lifecycle verification**
   - Verify five-minute live expiry, profile reuse, reconnect seeding, cache
     rollover, and stale request rejection.
6. **Operational verification**
   - Compare profiles and VRR against raw Yahoo responses for liquid and thinly
     traded symbols across a full extended-hours day.

Do not consider the feature complete until phase 2 establishes a trustworthy
numerator across both provider phase transitions.

## Test plan

Profile and cache:

- First subscription from any feature uses one 35-day provider response for
  both the profile and today's seed.
- Exact cumulative averages for known buckets.
- Missing buckets treated as zero incremental volume.
- Current date excluded and latest 20 completed dates selected.
- Insufficient history returns unavailable.
- DST boundaries align equivalent configured-local times.
- Holidays/weekends are excluded through `MarketSchedule`.
- Active-bucket expected volume is prorated correctly.
- Concurrent requests for one symbol produce one Yahoo fetch.
- Live idle expiry does not evict the historical profile.
- Reopening after live expiry reuses the profile and reseeds only live volume.
- Reopening while live state remains inside the grace period performs no seed
  request.
- Closed-market shutdown clears every profile; the next live day bootstraps a
  new baseline.
- Capacity eviction causes a safe refetch when the symbol is requested again.
- Provider failure returns unavailable without poisoning the cache.

Live:

- Monotonic full-day cumulative volume.
- Verified reset/no-reset behavior at provider transitions.
- Reconnect reconciliation does not double-count volume.
- Delayed frames cannot lower or corrupt the total.
- Postmarket volume contributes after implementation.
- A live `watch` subscription delivers the latest VRR after subscribe and may
  safely coalesce intermediate provider frames.
- Regular candle volume retains its existing regular-session meaning.
- At market close plus four hours, transport subscriptions stop, pending seed
  work is aborted, and live volume and profiles are cleared.
- The closed transition emits one unavailable update so VRR cannot remain
  visible as a stale numeric value.
- Existing subscribers restart automatically when the next live window opens.
- Profile failure does not interrupt live chart updates.

API/frontend:

- JSON accepts finite non-negative VRR or `null` only.
- Top and bottom charts use their respective symbol values.
- Theme Tracker and RS comparison-only symbols may warm profiles but do not
  emit chart VRR events.
- Profile completion emits a VRR event using the latest volume even without a
  subsequent Yahoo tick.
- Results from superseded request IDs are ignored.
- Label shows loading/unavailable/value states.
- RS toggle remains functional and layout remains stable.

## Acceptance criteria

- A symbol incurs at most one historical-profile fetch during one live market
  day, apart from retry after failure or capacity eviction.
- The first subscription from any feature obtains its profile and current-day
  seed from one 35-day Yahoo response, not two requests.
- The five-minute live-subscription expiry does not evict a valid historical
  profile; reopening normally performs only current-day volume seeding.
- No migration, candle table, or database profile storage is added.
- VRR uses one continuous cumulative day across all available premarket,
  regular, and postmarket volume.
- Historical and live values use the same configured-local bucket boundary.
- VRR uses the existing shared Yahoo subscription and existing market-chart
  WebSocket; no parallel streaming or polling path is added.
- The label updates during premarket, regular market, and postmarket and appears
  beside RS.
- No Yahoo live transport subscription, seed request, or numeric VRR remains
  after configured market close plus four hours.
- Yahoo/profile failure never breaks chart rendering or live prices.
- Cached historical OHLCV remains reusable by a future five-minute overlay
  during the cache lifetime without coupling VRR to that future feature.

## Review conclusion

This design fits the current boundaries with less operational and schema
complexity:

- `YahooClient` already supports five-minute `includePrePost` requests.
- `YahooService` already owns retries and `MarketSchedule`; VRR should build on
  it rather than calling Yahoo from API code.
- `MarketSchedule` remains the only timezone, DST, holiday, and market-date
  authority.
- `YahooLiveActor` is the correct owner for profile caching, live-volume
  normalization, and VRR publication because it receives each provider frame
  once and already owns shared, reference-counted subscription and seed state.
- Profiles survive the actor's five-minute live idle expiry but are cleared at
  the existing postmarket shutdown, matching their useful lifetime.
- `YahooLiveHandle` currently separates provider phases and drops postmarket
  volume; extending its state with a distinct full-day volume update preserves
  existing candle and session contracts.
- The shared actor performs the same bootstrap for every live symbol. The
  market-chart API only decides which subscribed symbols map to chart VRR
  events; subscription and seeding remain feature-neutral.
- A dedicated event on `MarketChartLiveClient` fits the existing socket while
  avoiding false coupling to regular or extended-hours chart deltas.
- `MarketChart` already owns the RS overlay and is the correct home for VRR.

The measured monthly-fetch cost does not justify database persistence for VRR.
Live transition tracing remains useful provider validation, but the normalized
state supports both full-day and session-local Yahoo volume frames.
