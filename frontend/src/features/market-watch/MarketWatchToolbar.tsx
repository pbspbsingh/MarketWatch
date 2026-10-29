import { Typography } from "@mui/material";
import { TickerStrengthControls } from "../ticker-strength/TickerStrengthControls";

export function MarketWatchToolbar() {
  return (
    <header className="market-watch-toolbar">
      <Typography component="h2">Market Watch</Typography>
      <TickerStrengthControls className="market-watch-ticker-strength" />
    </header>
  );
}
