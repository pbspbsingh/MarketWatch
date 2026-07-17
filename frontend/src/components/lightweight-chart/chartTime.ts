import type { Time } from "lightweight-charts";

const marketDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function isMarketDate(value: string): boolean {
  if (!marketDatePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function marketDateToChartTime(date: string): Time {
  if (!isMarketDate(date)) throw new RangeError(`Invalid market date: ${date}`);
  return date;
}

export function chartTimeToMarketDate(time: Time): string {
  if (typeof time === "string") {
    if (!isMarketDate(time)) throw new RangeError(`Invalid chart time: ${time}`);
    return time;
  }
  if (typeof time === "number") {
    const timestamp = new Date(time * 1000);
    if (Number.isNaN(timestamp.getTime())) throw new RangeError(`Invalid chart time: ${time}`);
    const date = timestamp.toISOString().slice(0, 10);
    if (!isMarketDate(date)) throw new RangeError(`Invalid chart time: ${time}`);
    return date;
  }
  const date = `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  if (!isMarketDate(date)) throw new RangeError(`Invalid chart time: ${date}`);
  return date;
}
