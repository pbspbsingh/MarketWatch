import { Typography } from "@mui/material";

const panels = ["Industries / Themes", "Tickers", "Chart"] as const;

export function MarketWatchPage() {
  return (
    <section className="market-watch-page" aria-label="Market Watch">
      {panels.map((panel) => (
        <section className="workspace-panel" key={panel}>
          <Typography className="panel-header" component="header">
            {panel}
          </Typography>
          <Typography className="panel-empty" color="text.secondary">
            Pending implementation
          </Typography>
        </section>
      ))}
    </section>
  );
}
