import { useEffect, useMemo, useState } from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import RemoveDoneIcon from "@mui/icons-material/RemoveDone";
import {
  Badge,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import { fetchIndustries, type IndustryRanking } from "../../api/industries";
import { Toast } from "../../components/Toast";

type SortKey = "relative_strength" | keyof IndustryRanking["performance"];
type SortDirection = "asc" | "desc";
type SortSetting = { key: SortKey; direction: SortDirection };

const sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "relative_strength", label: "RS" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];

const sortSettingKey = "market-watch.industry-sort";
const defaultSortSetting: SortSetting = { key: "relative_strength", direction: "desc" };

function readSortSetting(): SortSetting {
  const value = localStorage.getItem(sortSettingKey);
  if (value === null) return defaultSortSetting;

  try {
    const setting = JSON.parse(value) as Partial<SortSetting>;
    const validKey = sortOptions.some((option) => option.key === setting.key);
    const validDirection = setting.direction === "asc" || setting.direction === "desc";
    return validKey && validDirection
      ? { key: setting.key as SortKey, direction: setting.direction as SortDirection }
      : defaultSortSetting;
  } catch {
    return defaultSortSetting;
  }
}

function sortValue(industry: IndustryRanking, key: SortKey) {
  if (key === "relative_strength") return industry[key];
  return industry.performance[key];
}

function formatMetric(value: number, key: SortKey) {
  if (key === "relative_strength") return value.toFixed(1);
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

const metricColors = ["#8f4949", "#b66c4c", "#b89b52", "#9ba5b0", "#69a87e", "#377a51"];

function metricColor(value: number, minimum: number, maximum: number) {
  if (minimum === maximum) return metricColors[2];
  const normalized = (value - minimum) / (maximum - minimum);
  const index = Math.min(
    metricColors.length - 1,
    Math.floor(normalized * metricColors.length),
  );
  return metricColors[index];
}

function IndustriesPanel() {
  const [industries, setIndustries] = useState<IndustryRanking[]>([]);
  const [selectedIndustryKeys, setSelectedIndustryKeys] = useState<Set<string>>(() => new Set());
  const [sortSetting, setSortSetting] = useState(readSortSetting);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetchIndustries(controller.signal)
      .then(setIndustries)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    localStorage.setItem(sortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  const sortedIndustries = useMemo(
    () =>
      [...industries].sort((left, right) => {
        const comparison =
          sortValue(left, sortSetting.key) - sortValue(right, sortSetting.key);
        return sortSetting.direction === "desc" ? -comparison : comparison;
      }),
    [industries, sortSetting],
  );
  const metricRange = useMemo(() => {
    const values = industries.map((industry) => sortValue(industry, sortSetting.key));
    return {
      minimum: Math.min(...values),
      maximum: Math.max(...values),
    };
  }, [industries, sortSetting.key]);

  return (
    <section className="workspace-panel industries-panel">
      <header className="panel-header industry-header">
        <div className="industry-header-title">
          <Typography component="h2">Industries</Typography>
          {selectedIndustryKeys.size > 0 && (
            <IconButton
              size="small"
              aria-label={`Unselect ${selectedIndustryKeys.size} industries`}
              onClick={() => setSelectedIndustryKeys(new Set())}
            >
              <Badge badgeContent={selectedIndustryKeys.size} color="primary">
                <RemoveDoneIcon fontSize="small" />
              </Badge>
            </IconButton>
          )}
        </div>
        <div className="industry-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            aria-label="Sort industries by"
            onChange={(event) =>
              setSortSetting({ key: event.target.value as SortKey, direction: "desc" })
            }
          >
            {sortOptions.map((option) => (
              <MenuItem key={option.key} value={option.key}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <IconButton
            size="small"
            aria-label={`Sort ${sortSetting.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() =>
              setSortSetting((current) => ({
                ...current,
                direction: current.direction === "desc" ? "asc" : "desc",
              }))
            }
          >
            {sortSetting.direction === "desc" ? (
              <ArrowDownwardIcon fontSize="small" />
            ) : (
              <ArrowUpwardIcon fontSize="small" />
            )}
          </IconButton>
        </div>
      </header>
      {loading && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading industries</Typography>
        </div>
      )}
      {!loading && !error && industries.length === 0 && (
        <Typography className="panel-empty" color="text.secondary">
          No industry snapshot available
        </Typography>
      )}
      {!loading && !error && industries.length > 0 && (
        <ol className="industry-list" aria-label="Industry rankings">
          {sortedIndustries.map((industry) => {
            const metric = sortValue(industry, sortSetting.key);
            return (
              <li key={industry.key}>
                <button
                  className="industry-list-item"
                  type="button"
                  aria-pressed={selectedIndustryKeys.has(industry.key)}
                  onClick={() =>
                    setSelectedIndustryKeys((selected) => {
                      const next = new Set(selected);
                      if (next.has(industry.key)) next.delete(industry.key);
                      else next.add(industry.key);
                      return next;
                    })
                  }
                >
                  <span className="industry-name">{industry.name}</span>
                  <span
                    className="industry-metric"
                    style={{
                      color: metricColor(metric, metricRange.minimum, metricRange.maximum),
                    }}
                  >
                    {formatMetric(metric, sortSetting.key)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function EmptyPanel({ title }: { title: string }) {
  return (
    <section className="workspace-panel">
      <Typography className="panel-header" component="header">
        {title}
      </Typography>
      <Typography className="panel-empty" color="text.secondary">
        Pending implementation
      </Typography>
    </section>
  );
}

export function MarketWatchPage() {
  return (
    <section className="market-watch-page" aria-label="Market Watch">
      <IndustriesPanel />
      <EmptyPanel title="Tickers" />
      <EmptyPanel title="Chart" />
    </section>
  );
}
