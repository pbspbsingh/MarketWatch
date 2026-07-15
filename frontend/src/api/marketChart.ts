export type MarketChartInterval = "daily" | "weekly";

export interface MarketChartCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketChartPoint {
  date: string;
  value: number;
}

export interface MarketChartSeries {
  period: number;
  points: MarketChartPoint[];
}

export interface MarketChartData {
  symbol: string;
  interval: MarketChartInterval;
  candles: MarketChartCandle[];
  moving_averages: MarketChartSeries[];
  volume_average?: MarketChartSeries;
}

export interface MarketChartSnapshot extends MarketChartData {
  volume_average: MarketChartSeries;
  earliest_date: string | null;
  latest_date: string | null;
  has_more: boolean;
}
