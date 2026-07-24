export function shiftYears(dateText: string, years: number) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDate();
  const targetYear = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  date.setUTCDate(1);
  date.setUTCFullYear(targetYear);
  date.setUTCDate(Math.min(
    day,
    new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate(),
  ));
  return date.toISOString().slice(0, 10);
}
