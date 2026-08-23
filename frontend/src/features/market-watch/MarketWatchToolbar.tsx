import RefreshIcon from "@mui/icons-material/Refresh";
import {
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { TickerStrengthControls } from "../ticker-strength/TickerStrengthControls";

type MarketWatchToolbarProps = {
  tickerStrengthDisabled: boolean;
  membershipRefreshDisabled: boolean;
  membershipRefreshTooltip: string;
  refreshingMembership: boolean;
  onRefreshMembership: () => void;
};

export function MarketWatchToolbar({
  tickerStrengthDisabled,
  membershipRefreshDisabled,
  membershipRefreshTooltip,
  refreshingMembership,
  onRefreshMembership,
}: MarketWatchToolbarProps) {
  return (
    <header className="market-watch-toolbar">
      <Typography component="h2">Market Watch</Typography>
      <Tooltip title={membershipRefreshTooltip}>
        <span className="market-watch-membership-refresh">
          <IconButton
            size="small"
            aria-label="Refresh selected industry tickers"
            disabled={membershipRefreshDisabled || refreshingMembership}
            onClick={onRefreshMembership}
          >
            {refreshingMembership
              ? <CircularProgress size="0.875rem" color="inherit" />
              : <RefreshIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      <TickerStrengthControls
        className="market-watch-ticker-strength"
        disabled={tickerStrengthDisabled}
      />
    </header>
  );
}
