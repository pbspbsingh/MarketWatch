import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

export interface LeftPriceLineLabel {
  price: number;
  text: string;
  color: string;
  textColor: string;
}

export class LeftPriceLineLabels implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<"Candlestick"> | null = null;
  private labels: LeftPriceLineLabel[] = [];
  private requestUpdate: (() => void) | null = null;
  private readonly view: IPrimitivePaneView = {
    zOrder: () => "top",
    renderer: () => this.renderer,
  };
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => target.useMediaCoordinateSpace(({ context }) => {
      if (this.series === null) return;
      context.font = "600 11px sans-serif";
      context.textBaseline = "middle";
      for (const label of this.labels) {
        const y = this.series.priceToCoordinate(label.price);
        if (y === null) continue;
        const width = Math.ceil(context.measureText(label.text).width) + 10;
        context.fillStyle = label.color;
        context.fillRect(0, y - 9, width, 18);
        context.fillStyle = label.textColor;
        context.fillText(label.text, 5, y);
      }
    }),
  };

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.series = series as ISeriesApi<"Candlestick">;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  setLabels(labels: LeftPriceLineLabel[]): void {
    this.labels = labels;
    this.requestUpdate?.();
  }
}
