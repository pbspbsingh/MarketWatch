import AddIcon from "@mui/icons-material/Add";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import FilterAltOffOutlinedIcon from "@mui/icons-material/FilterAltOffOutlined";
import SearchIcon from "@mui/icons-material/Search";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import {
  FormControl,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  TextField,
  ToggleButton,
  Tooltip,
} from "@mui/material";
import type { TradeAccount, TradeFilters, TradeTag } from "../../api/tradeAnalyzer";

interface AnalyzerToolbarProps {
  accounts: TradeAccount[];
  tags: TradeTag[];
  filters: TradeFilters;
  searchQuery: string;
  chartVisible: boolean;
  onFiltersChange: (filters: TradeFilters) => void;
  onSearchQueryChange: (query: string) => void;
  onClearFilters: () => void;
  onImport: () => void;
  onAddManual: () => void;
  onToggleChart: () => void;
}

export function AnalyzerToolbar({
  accounts,
  tags,
  filters,
  searchQuery,
  chartVisible,
  onFiltersChange,
  onSearchQueryChange,
  onClearFilters,
  onImport,
  onAddManual,
  onToggleChart,
}: AnalyzerToolbarProps) {
  const hasActiveFilters = filters.status !== undefined
    || filters.monthFrom !== undefined
    || filters.monthTo !== undefined
    || filters.query !== undefined
    || (filters.tagIds?.length ?? 0) > 0;

  return (
    <header className="trade-analyzer-toolbar">
      <div className="trade-analyzer-title">
        <ShowChartIcon fontSize="small" />
        <span>Trade Analyzer</span>
      </div>
      <FormControl size="small" className="trade-filter-account">
        <Select
          value={filters.account ?? accounts[0]?.id ?? ""}
          aria-label="Account"
          disabled={accounts.length === 0}
          onChange={(event) => onFiltersChange({
            ...filters,
            account: Number(event.target.value),
          })}
        >
          {accounts.map((account) => (
            <MenuItem key={account.id} value={account.id}>{account.label}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        className="trade-filter-search"
        size="small"
        value={searchQuery}
        placeholder="Search symbols, comments, tags…"
        slotProps={{
          htmlInput: { "aria-label": "Search trades" },
          input: {
            startAdornment: (
              <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
            ),
          },
        }}
        onChange={(event) => onSearchQueryChange(event.target.value)}
      />
      <FormControl size="small" className="trade-filter-status">
        <Select
          value={filters.status ?? "all"}
          aria-label="Trade status"
          onChange={(event) => onFiltersChange({
            ...filters,
            status: event.target.value === "all" ? undefined : String(event.target.value),
          })}
        >
          <MenuItem value="all">All statuses</MenuItem>
          <MenuItem value="open">Open</MenuItem>
          <MenuItem value="closed">Closed</MenuItem>
          <MenuItem value="incomplete">Incomplete</MenuItem>
          <MenuItem value="conflicted">Conflicted</MenuItem>
          <MenuItem value="unprotected">Unprotected</MenuItem>
        </Select>
      </FormControl>
      <TextField
        className="trade-filter-month"
        size="small"
        type="month"
        label="From"
        value={filters.monthFrom ?? ""}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: filters.monthTo } }}
        onChange={(event) => onFiltersChange({
          ...filters,
          monthFrom: event.target.value || undefined,
          monthTo: event.target.value !== "" && filters.monthTo !== undefined
            && event.target.value > filters.monthTo
            ? event.target.value
            : filters.monthTo,
        })}
      />
      <TextField
        className="trade-filter-month"
        size="small"
        type="month"
        label="To"
        value={filters.monthTo ?? ""}
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: filters.monthFrom } }}
        onChange={(event) => onFiltersChange({
          ...filters,
          monthFrom: event.target.value !== "" && filters.monthFrom !== undefined
            && event.target.value < filters.monthFrom
            ? event.target.value
            : filters.monthFrom,
          monthTo: event.target.value || undefined,
        })}
      />
      <FormControl size="small" className="trade-filter-tags">
        <Select
          multiple
          displayEmpty
          value={filters.tagIds ?? []}
          aria-label="Tags"
          renderValue={(selected) => selected.length === 0
            ? "All tags"
            : `${selected.length} tag${selected.length === 1 ? "" : "s"}`}
          onChange={(event) => onFiltersChange({
            ...filters,
            tagIds: typeof event.target.value === "string"
              ? []
              : event.target.value as number[],
          })}
        >
          {tags.map((tag) => <MenuItem key={tag.id} value={tag.id}>{tag.name}</MenuItem>)}
        </Select>
      </FormControl>
      {(filters.tagIds?.length ?? 0) > 1 && (
        <FormControl size="small" className="trade-filter-tag-mode">
          <Select
            value={filters.tagMode ?? "any"}
            aria-label="Tag matching"
            onChange={(event) => onFiltersChange({ ...filters, tagMode: event.target.value as "any" | "all" })}
          >
            <MenuItem value="any">Match any</MenuItem>
            <MenuItem value="all">Match all</MenuItem>
          </Select>
        </FormControl>
      )}
      <Tooltip title="Clear filters">
        <span>
          <IconButton
            size="small"
            aria-label="Clear filters"
            disabled={!hasActiveFilters}
            onClick={onClearFilters}
          >
            <FilterAltOffOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <div className="trade-toolbar-spacer" />
      <Tooltip title={chartVisible ? "Hide chart pane" : "Show chart pane"}>
        <ToggleButton
          size="small"
          value="chart"
          selected={chartVisible}
          aria-label={chartVisible ? "Hide chart pane" : "Show chart pane"}
          onChange={onToggleChart}
        >
          <ViewSidebarOutlinedIcon fontSize="small" />
        </ToggleButton>
      </Tooltip>
      <Tooltip title="Import statement">
        <IconButton size="small" aria-label="Import statement" onClick={onImport}>
          <FileUploadOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={accounts.length === 0 ? "Import a broker account first" : "Add a manual entry"}>
        <span>
          <IconButton
            size="small"
            color="primary"
            aria-label="Add manual entry"
            disabled={accounts.length === 0}
            onClick={onAddManual}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </header>
  );
}
