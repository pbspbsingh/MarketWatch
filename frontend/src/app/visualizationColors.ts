/** Data-encoding colors that intentionally sit outside the application UI palette. */
export function categoricalColor(id: number) {
  return `hsl(${(id * 137.508) % 360} 72% 60%)`;
}

type RgbColor = readonly [red: number, green: number, blue: number];

export const tickerMetricScale = {
  negativeLight: [255, 126, 126],
  negativeStrong: [180, 30, 30],
  neutral: [230, 200, 79],
  positiveLight: [139, 220, 50],
  positiveStrong: [0, 184, 63],
} as const satisfies Record<string, RgbColor>;

export function interpolateRgbColor(
  start: RgbColor,
  end: RgbColor,
  amount: number,
) {
  const position = Math.min(amount, 1);
  const channels = start.map((component, index) =>
    Math.round(component + position * (end[index] - component)));
  return `rgb(${channels.join(",")})`;
}
