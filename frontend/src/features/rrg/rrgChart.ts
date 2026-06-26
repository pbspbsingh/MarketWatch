import type { RrgItem } from "./rrgTypes";

const chartMargin = { top: 36, right: 36, bottom: 44, left: 52 };

export function getRrgViewport(items: RrgItem[], width: number, height: number) {
  const M = chartMargin;
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  let xMin = 95;
  let xMax = 105;
  let yMin = 95;
  let yMax = 105;

  if (items.length) {
    const xs = items.flatMap((item) => item.points.map((point) => point.rs_ratio));
    const ys = items.flatMap((item) => item.points.map((point) => point.rs_momentum));
    const allX = [...xs, 100];
    const allY = [...ys, 100];
    xMin = Math.min(...allX);
    xMax = Math.max(...allX);
    yMin = Math.min(...allY);
    yMax = Math.max(...allY);
    const padX = Math.max((xMax - xMin) * 0.1, 1.5);
    const padY = Math.max((yMax - yMin) * 0.1, 1.5);
    xMin -= padX;
    xMax += padX;
    yMin -= padY;
    yMax += padY;
    if (xMin > 100) xMin = 99;
    if (xMax < 100) xMax = 101;
    if (yMin > 100) yMin = 99;
    if (yMax < 100) yMax = 101;
  }

  const toX = (value: number) => M.left + ((value - xMin) / (xMax - xMin)) * plotW;
  const toY = (value: number) => M.top + plotH - ((value - yMin) / (yMax - yMin)) * plotH;

  return { M, plotW, plotH, xMin, xMax, yMin, yMax, toX, toY };
}
