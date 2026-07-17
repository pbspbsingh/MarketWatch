#!/usr/bin/env python3
"""Probe Yahoo's authenticated quote endpoint without application integration."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.0.0 Safari/537.36"
)
QUOTE_FIELDS = (
    "symbol",
    "marketState",
    "exchange",
    "exchangeTimezoneName",
    "regularMarketTime",
    "regularMarketPrice",
    "regularMarketPreviousClose",
    "regularMarketOpen",
    "regularMarketDayHigh",
    "regularMarketDayLow",
    "regularMarketVolume",
    "preMarketPrice",
    "postMarketPrice",
)


class ProbeError(RuntimeError):
    pass


class YahooSession:
    def __init__(self, timeout: float) -> None:
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
        )
        self.timeout = timeout
        self.crumb_source: str | None = None

    def get(self, url: str, accept: str) -> str:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": accept,
                "Accept-Language": "en-US,en;q=0.5",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            body = error.read(256).decode("utf-8", errors="replace").strip()
            detail = f": {body}" if body else ""
            raise ProbeError(f"HTTP {error.code} from {url}{detail}") from error
        except urllib.error.URLError as error:
            raise ProbeError(f"request failed for {url}: {error.reason}") from error

    def crumb(self) -> str:
        attempts = (
            (
                "https://fc.yahoo.com/",
                "https://query2.finance.yahoo.com/v1/test/getcrumb",
            ),
            (
                "https://finance.yahoo.com/",
                "https://query1.finance.yahoo.com/v1/test/getcrumb",
            ),
        )
        failures: list[str] = []
        for cookie_url, crumb_url in attempts:
            try:
                self.get(cookie_url, "text/html,*/*;q=0.8")
                crumb = self.get(crumb_url, "text/plain").strip()
                if crumb and "Unauthorized" not in crumb and "Too Many" not in crumb:
                    self.crumb_source = crumb_url
                    return crumb
                failures.append(f"invalid crumb from {crumb_url}: {crumb[:80]!r}")
            except ProbeError as error:
                failures.append(str(error))
        raise ProbeError("; ".join(failures))

    def quotes(self, symbols: list[str], crumb: str) -> dict[str, object]:
        query = urllib.parse.urlencode(
            {
                "symbols": ",".join(symbols),
                "crumb": crumb,
            },
        )
        failures: list[str] = []
        for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
            url = f"https://{host}/v7/finance/quote?{query}"
            try:
                payload = self.get(url, "application/json")
                decoded = json.loads(payload)
                if not isinstance(decoded, dict):
                    raise ProbeError(f"non-object response from {url}")
                return decoded
            except (ProbeError, json.JSONDecodeError) as error:
                failures.append(str(error))
        raise ProbeError("; ".join(failures))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("symbols", nargs="+", help="Yahoo symbols, for example AAPL SPY")
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--raw", action="store_true", help="print the complete quote response")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    symbols = [symbol.strip().upper() for symbol in args.symbols if symbol.strip()]
    if not symbols:
        print("at least one non-empty symbol is required", file=sys.stderr)
        return 2

    session = YahooSession(args.timeout)
    try:
        crumb = session.crumb()
        payload = session.quotes(symbols, crumb)
    except ProbeError as error:
        print(f"quote probe failed: {error}", file=sys.stderr)
        return 1

    if args.raw:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    quote_response = payload.get("quoteResponse")
    results = quote_response.get("result") if isinstance(quote_response, dict) else None
    if not isinstance(results, list):
        print("quote probe failed: response has no quoteResponse.result array", file=sys.stderr)
        return 1

    quotes = [
        {field: quote.get(field) for field in QUOTE_FIELDS if field in quote}
        for quote in results
        if isinstance(quote, dict)
    ]
    print(
        json.dumps(
            {
                "authentication": session.crumb_source,
                "quotes": quotes,
            },
            indent=2,
            sort_keys=True,
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
