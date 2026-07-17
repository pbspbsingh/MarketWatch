import { Link } from "react-router-dom";
import AssessmentOutlinedIcon from "@mui/icons-material/AssessmentOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Chip,
  CircularProgress,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ChartSummary } from "../../api/chart";
import {
  chartEngineKey,
  chartIntervalKey,
  chartRelativeStrengthModeKey,
  chartThemeEtfKey,
} from "./constants";
import type { ChartEngine, RelativeStrengthMode } from "./types";
import {
  formatVolume,
  industryMarketWatchUrl,
  themeMarketWatchUrl,
  themesMarketWatchUrl,
  tradingViewSymbolUrl,
} from "./utils";
import "./chart-header.css";

interface ChartHeaderProps {
  summary: ChartSummary | undefined;
  summaryLoading: boolean;
  selectedTicker: string | undefined;
  selectedIndustry: string;
  interval: "D" | "W";
  showThemeEtfChart: boolean;
  selectedThemeEtf?: string;
  setInterval: (interval: "D" | "W") => void;
  setShowThemeEtfChart?: (updater: (enabled: boolean) => boolean) => void;
  setSelectedThemeEtf?: (symbol: string) => void;
  setDetailsOpen?: (open: boolean) => void;
  contextLabel?: string;
  chartEngine?: ChartEngine;
  setChartEngine?: (engine: ChartEngine) => void;
  relativeStrengthMode?: RelativeStrengthMode;
  setRelativeStrengthMode?: (mode: RelativeStrengthMode) => void;
}

export function ChartHeader({
  summary,
  summaryLoading,
  selectedTicker,
  selectedIndustry,
  interval,
  showThemeEtfChart,
  selectedThemeEtf,
  setInterval,
  setShowThemeEtfChart,
  setSelectedThemeEtf,
  setDetailsOpen,
  contextLabel,
  chartEngine,
  setChartEngine,
  relativeStrengthMode,
  setRelativeStrengthMode,
}: ChartHeaderProps) {
  return (
    <header className="panel-header chart-header">
      <div className="chart-header-identity">
        <Typography component="h2">
          {contextLabel !== undefined ? (
            <span>{contextLabel}</span>
          ) : summary?.industry === undefined || summary.industry === null ? (
            <span>{selectedIndustry}</span>
          ) : (
            <Link
              className="chart-context-link"
              to={industryMarketWatchUrl(summary.industry.key)}
              target="_blank"
              rel="noreferrer"
            >
              {summary.industry.name}
            </Link>
          )}{" "}
          /{" "}
          {summary === undefined ? (
            <span>{selectedTicker ?? "Select a ticker"}</span>
          ) : (
            <Tooltip
              arrow
              placement="bottom-start"
              disableHoverListener={!summary.company_name && !summary.description}
              title={
                <div className="ticker-description-tooltip">
                  {summary.company_name !== null ? (
                    <Typography
                      className="ticker-description-title"
                      component="p"
                    >
                      {summary.company_name}
                    </Typography>
                  ) : null}
                  {summary.description !== null ? (
                    <Typography component="p">{summary.description}</Typography>
                  ) : null}
                </div>
              }
            >
              <a
                href={tradingViewSymbolUrl(summary.tradingview_symbol)}
                target="_blank"
                rel="noreferrer"
              >
                {summary.symbol}
              </a>
            </Tooltip>
          )}
        </Typography>
        {setDetailsOpen !== undefined && (
          <IconButton
            size="small"
            aria-label="Open ticker details"
            disabled={selectedTicker === undefined}
            onClick={() => setDetailsOpen(true)}
          >
            <AssessmentOutlinedIcon fontSize="small" />
          </IconButton>
        )}
        {chartEngine !== undefined && setChartEngine !== undefined && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={chartEngine}
            aria-label="Chart implementation"
            onChange={(_, value: ChartEngine | null) => {
              if (value !== null) {
                localStorage.setItem(chartEngineKey, value);
                setChartEngine(value);
              }
            }}
          >
            <ToggleButton value="tradingview" title="TradingView">TV</ToggleButton>
            <ToggleButton value="lightweight" title="Lightweight Charts">LW</ToggleButton>
          </ToggleButtonGroup>
        )}
      </div>
      <div className="chart-header-controls">
        {summaryLoading && (
          <div className="chart-header-loading">
            <CircularProgress size="0.75rem" />
            <Typography color="text.secondary">Loading</Typography>
          </div>
        )}
        {!summaryLoading && summary !== undefined && (
          <>
            {summary.themes.length > 0 && (
              <div className="chart-theme-chips">
                {summary.themes.map((theme) => (
                  <Chip
                    key={theme}
                    size="small"
                    label={theme}
                    component={Link}
                    to={themeMarketWatchUrl(theme)}
                    target="_blank"
                    rel="noreferrer"
                    clickable
                  />
                ))}
                {summary.themes.length > 1 && (
                  <IconButton
                    className="chart-theme-link"
                    size="small"
                    component={Link}
                    to={themesMarketWatchUrl(summary.themes)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open Market Watch with all ticker themes selected"
                  >
                    <OpenInNewIcon fontSize="inherit" />
                  </IconButton>
                )}
              </div>
            )}
            <ChartIndicators summary={summary} />
          </>
        )}
        {summary !== undefined
          && chartEngine === "lightweight"
          && relativeStrengthMode !== undefined
          && setRelativeStrengthMode !== undefined && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={relativeStrengthMode}
            aria-label="Relative strength overlay"
            onChange={(_, value: RelativeStrengthMode | null) => {
              const mode = value ?? "none";
              localStorage.setItem(chartRelativeStrengthModeKey, mode);
              setRelativeStrengthMode(mode);
            }}
          >
            <ToggleButton value="line">RS</ToggleButton>
            <ToggleButton value="trend">RST</ToggleButton>
          </ToggleButtonGroup>
        )}
        <ToggleButtonGroup
          exclusive
          size="small"
          value={interval}
          aria-label="Chart interval"
          onChange={(_, value: "D" | "W" | null) => {
            if (value !== null) {
              setInterval(value);
              localStorage.setItem(chartIntervalKey, value);
            }
          }}
        >
          <ToggleButton value="D">Daily</ToggleButton>
          <ToggleButton value="W">Weekly</ToggleButton>
        </ToggleButtonGroup>
        {setShowThemeEtfChart !== undefined && summary !== undefined && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={showThemeEtfChart ? selectedThemeEtf : "market"}
            aria-label="Bottom chart benchmark"
            onChange={(_, value: string | null) => {
              if (value === null) return;
              const enabled = value !== "market";
              localStorage.setItem(chartThemeEtfKey, enabled ? "1" : "0");
              setShowThemeEtfChart(() => enabled);
              if (enabled) setSelectedThemeEtf?.(value);
            }}
          >
            <ToggleButton value="market">
              {summary.benchmark_symbol.slice(summary.benchmark_symbol.lastIndexOf(":") + 1)}
            </ToggleButton>
            {summary.theme_benchmarks.map((theme) => (
              <ToggleButton
                key={theme.etf_symbol}
                value={theme.etf_symbol}
                title={theme.theme_name}
              >
                {theme.etf_symbol}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}
      </div>
    </header>
  );
}

function ChartIndicators({ summary }: { summary: ChartSummary }) {
  return (
    <div className="chart-indicators">
      <Typography>ADR {summary.adr_percent.toFixed(1)}%</Typography>
      <Typography>
        Ext {summary.extension_from_50_sma === null ? "N/A" : `${summary.extension_from_50_sma >= 0 ? "+" : ""}${summary.extension_from_50_sma.toFixed(1)}x`}
      </Typography>
      <Typography>AVol {formatVolume(summary.average_volume)}</Typography>
    </div>
  );
}
