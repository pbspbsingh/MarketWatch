import RefreshIcon from "@mui/icons-material/Refresh";
import {
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  tickerStrengthMaximumSessions,
  tickerStrengthMinimumSessions,
  useTickerStrength,
} from "../ticker-strength/TickerStrengthContext";

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
  const tickerStrength = useTickerStrength();
  const tickerStrengthBusy = !tickerStrengthDisabled
    && (tickerStrength.loading || tickerStrength.calculating);
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
      <Typography
        className={`ticker-strength-label${tickerStrengthBusy
          ? " ticker-strength-label--loading"
          : ""}`}
        component="span"
        aria-busy={tickerStrengthBusy}
      >
        Ticker Strength
      </Typography>
      <label className="ticker-strength-window">
        <Typography component="span">Days</Typography>
        <Typography component="span">{tickerStrengthMinimumSessions}</Typography>
        <Slider
          size="small"
          min={tickerStrengthMinimumSessions}
          max={tickerStrengthMaximumSessions}
          step={1}
          value={tickerStrength.draftSessions}
          valueLabelDisplay="auto"
          aria-label="Ticker Strength trading days"
          disabled={tickerStrengthDisabled}
          onChange={(_, value) =>
            tickerStrength.setDraftSessions(Array.isArray(value) ? value[0] : value)
          }
          onChangeCommitted={(_, value) =>
            tickerStrength.commitSessions(Array.isArray(value) ? value[0] : value)
          }
        />
        <Typography component="span">{tickerStrengthMaximumSessions}</Typography>
        <Typography className="ticker-strength-window-value" component="span">
          {tickerStrength.draftSessions}D
        </Typography>
      </label>
      <label className="ticker-strength-benchmark">
        <Typography component="span">Benchmark</Typography>
        <Select
          size="small"
          value={tickerStrength.benchmark}
          disabled={tickerStrengthDisabled
            || tickerStrength.loading
            || tickerStrength.benchmarks.length === 0}
          aria-label="Ticker Strength benchmark"
          onChange={(event) => tickerStrength.setBenchmark(event.target.value)}
        >
          {tickerStrength.benchmarks.map((option) => (
            <MenuItem key={`${option.kind}:${option.symbol}`} value={option.symbol}>
              {option.name} · {option.symbol}
            </MenuItem>
          ))}
        </Select>
      </label>
    </header>
  );
}
