# Yahoo Quote and WebSocket POC Findings

Status: Quote and WebSocket probes complete.

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

Tool: `tools/yahoo_ws_probe.mjs`

Primary command:

```text
node tools/yahoo_ws_probe.mjs --duration 35 \
  --unsubscribe BTC-USD --unsubscribe-after 10 \
  AAPL BTC-USD ETH-USD
```

### Connection and commands

- Endpoint: `wss://streamer.finance.yahoo.com/?version=2`.
- The WebSocket connection succeeded without cookie/crumb authentication.
- Subscribe command: JSON text `{"subscribe":["AAPL","BTC-USD","ETH-USD"]}`.
- Unsubscribe command: JSON text `{"unsubscribe":["BTC-USD"]}`.
- The server sent no explicit subscription acknowledgement; successful subscription was inferred from pricing traffic.
- Re-sending the active subscription every 15 seconds kept the connection active and matches the application-level heartbeat used by current yfinance clients.
- WebSocket control-frame ping/pong is handled below the probe's browser-compatible API and was not directly observable.

### Message encoding

- Server frames were JSON text envelopes containing a base64 `message` field.
- Base64 content decoded as protobuf `PricingData` using the public field layout mirrored by current yfinance.
- `time` was Unix epoch milliseconds, unlike the quote endpoint's Unix seconds.
- Messages are partial snapshots: fields absent from a protobuf message must not clear previously seeded candle fields.

Observed fields included:

- Symbol/id, price, time, currency, exchange.
- Numeric quote type and market-hours state.
- Change and change percent.
- Day volume, high, low, open, and previous close when supplied.
- Bid/ask and other optional instrument-specific fields when supplied.

### Observed traffic

- AAPL emitted three post-session messages with price/change fields but without full OHLCV. Its observed `marketHours` value was `4`.
- BTC-USD emitted two complete crypto pricing messages before unsubscribe and zero afterward.
- ETH-USD emitted six messages and continued after the 15- and 30-second subscription heartbeats.
- Crypto messages included price, day/24-hour volume, high, low, open, circulating supply, and market cap. Their observed `marketHours` value was `1`.
- The probe closed cleanly with WebSocket code 1000.
- A separate fresh connection subscribed to ETH-USD and immediately resumed pricing traffic, confirming reconnect requires a new subscribe command.

### Protocol conclusions

- WebSocket transport is feasible with no production authentication dependency.
- The backend must decode base64 protobuf and treat all fields as optional.
- Quote REST data is still required to seed/reconcile a complete equity session candle; WebSocket messages alone can be sparse outside regular hours.
- Market-hours and quote-type numeric values require explicit fixture-backed mapping before production use.
- Reconnect must restore the full desired subscription set.
- Unsubscribe was effective in observed traffic, though Yahoo provides no acknowledgement.
- The 100-symbol limit was not asserted by the provider during this small probe. Keep 100 as an application hard cap and capacity policy, not a verified Yahoo guarantee.
- Day-volume semantics vary by instrument/session and must be treated as a provider snapshot, not an increment.

References used only to validate the observed wire layout:

- `https://github.com/ranaroussi/yfinance/blob/main/yfinance/pricing.proto`
- `https://github.com/ranaroussi/yfinance/blob/main/yfinance/live.py`
