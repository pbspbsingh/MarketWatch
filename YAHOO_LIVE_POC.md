# Yahoo Quote and WebSocket POC Findings

Status: Quote probe complete; WebSocket probe pending task 0.4.

The probes are isolated tools. They are not imported by application code and do not change persistence, chart APIs, or analytical flows.

## Quote probe — 2026-07-14

Tool: `tools/yahoo_quote_probe.py`

Command:

```text
python3 -B tools/yahoo_quote_probe.py AAPL SPY
```

### Authentication and endpoint

- Cookie-jar session with the same browser user agent used by the Rust Yahoo client.
- Attempted the existing primary `fc.yahoo.com` + `query2` crumb flow first.
- This run succeeded through the existing fallback `finance.yahoo.com` cookie + `query1.finance.yahoo.com/v1/test/getcrumb` flow.
- Quote request: authenticated `query1.finance.yahoo.com/v7/finance/quote` with comma-separated symbols and crumb.
- AAPL and SPY were returned together in one request.

### Observed fields

The run occurred after the regular session. Both results reported `marketState = POSTPOST` and supplied:

- `symbol`
- `exchange`
- `exchangeTimezoneName`
- `regularMarketTime`
- `regularMarketPrice`
- `regularMarketPreviousClose`
- `regularMarketOpen`
- `regularMarketDayHigh`
- `regularMarketDayLow`
- `regularMarketVolume`
- `postMarketPrice`

Observed regular-market fixtures:

| Symbol | Time | Open | High | Low | Price | Previous close | Volume |
|---|---|---:|---:|---:|---:|---:|---:|
| AAPL | `2026-07-14T20:00:01Z` | 313.64 | 316.19 | 311.91 | 314.86 | 317.31 | 36,328,962 |
| SPY | `2026-07-14T20:00:00Z` | 750.91 | 753.30 | 748.66 | 751.83 | 749.17 | 35,135,286 |

`regularMarketTime` aligned with the configured 13:00 America/Los_Angeles close. `postMarketPrice` remained separate from `regularMarketPrice`, so regular-session candles can exclude extended-hours prices.

### Rate-limit and error observations

- A prior unauthenticated direct Yahoo chart request from the same environment returned `Edge: Too Many Requests`.
- Two authenticated quote-probe runs succeeded.
- The probe performs no automatic retry and surfaces HTTP status/body details, including 429, so throttling is visible rather than hidden.
- Production quote access should reuse the existing single-request permit, randomized delay, retry classification, cookie jar, and crumb invalidation instead of copying the probe transport.

### Conclusions

- The quote endpoint can seed a complete current regular-session OHLCV candle when all observed fields are present.
- `regularMarketPreviousClose` can identify the prior completed close.
- Every quote field must remain optional; pre/post fields varied with market state and Yahoo has no stable public contract.
- Market state alone is insufficient. Validate `regularMarketTime` against the configured market schedule before assigning a market date.
- Quote data is suitable for future chart-only provisional repair, but it must not be persisted or used by ranking/performance flows.
- No production integration is part of the historical Lightweight Charts delivery.

## WebSocket probe

Pending task 0.4.
