import assert from "node:assert/strict";
import test from "node:test";
import { tradeTimeFormatters } from "../src/features/trade-logs/timeFormat.ts";

test("trade times use the configured zone in summer and winter", () => {
  const labels = tradeTimeFormatters("America/Los_Angeles");
  assert.equal(labels.hour.format(new Date("2026-07-16T13:30:00Z")), "06:30");
  assert.equal(labels.hour.format(new Date("2026-01-16T14:30:00Z")), "06:30");
  assert.equal(labels.day.format(new Date("2026-07-17T00:30:00Z")), "16 Jul");
  assert.equal(labels.dateTime.format(new Date("2026-07-17T00:30:00Z")), "16 Jul 2026, 17:30");
});

test("trade times follow daylight saving transitions", () => {
  const labels = tradeTimeFormatters("America/Los_Angeles");
  assert.equal(labels.hour.format(new Date("2026-03-08T09:59:00Z")), "01:59");
  assert.equal(labels.hour.format(new Date("2026-03-08T10:00:00Z")), "03:00");
  assert.equal(labels.hour.format(new Date("2026-11-01T08:59:00Z")), "01:59");
  assert.equal(labels.hour.format(new Date("2026-11-01T09:00:00Z")), "01:00");
});

test("a different configured zone changes all trade time formatters", () => {
  const date = new Date("2026-07-16T13:30:00Z");
  const newYork = tradeTimeFormatters("America/New_York");
  assert.equal(newYork.hour.format(date), "09:30");
  const utc = tradeTimeFormatters("UTC");
  assert.equal(utc.hour.format(date), "13:30");
  assert.equal(utc.day.format(date), "16 Jul");
  assert.equal(utc.dateTime.format(date), "16 Jul 2026, 13:30");
});
