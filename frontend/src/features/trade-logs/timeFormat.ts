export function tradeTimeFormatters(timeZone: string) {
  return {
    hour: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    day: new Intl.DateTimeFormat("en-GB", { timeZone, month: "short", day: "2-digit" }),
    dateTime: new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
}
