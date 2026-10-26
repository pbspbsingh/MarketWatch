import { Fragment, useEffect, useMemo, useState } from "react";
import { Alert, Button, CircularProgress, IconButton, LinearProgress, Tooltip } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import StarOutlineRoundedIcon from "@mui/icons-material/StarOutlineRounded";
import StarRoundedIcon from "@mui/icons-material/StarRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import TrendingUpRoundedIcon from "@mui/icons-material/TrendingUpRounded";
import TrendingDownRoundedIcon from "@mui/icons-material/TrendingDownRounded";
import { fetchInstitutions, type FundOwnership, type FundPosition, type InstitutionsReport, type OwnershipProgress } from "../api/institutions";
import "./ticker-institutions.css";

const trackedKey = "institutions.tracked-funds";
const filters = [["all", "All funds"], ["new", "New"], ["added", "Adding"], ["reduced", "Reducing"], ["exited", "Exited"], ["tracked", "Tracked"]] as const;
type Filter = (typeof filters)[number][0];
type Sort = "ownership" | "change" | "name";
const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const precise = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const sharesFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const percent = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(2)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${integer.format(value)}`;
const date = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function initialTracked(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(trackedKey) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch { return new Set(); }
}

export function TickerInstitutionsTab({ symbol }: { symbol: string }) {
  return <InstitutionsContent key={symbol} symbol={symbol} />;
}

function InstitutionsContent({ symbol }: { symbol: string }) {
  const [report, setReport] = useState<InstitutionsReport>();
  const [progress, setProgress] = useState<OwnershipProgress>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState(0);
  const [quarter, setQuarter] = useState(3);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("ownership");
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const [tracked, setTracked] = useState(initialTracked);

  useEffect(() => {
    const controller = new AbortController();
    void fetchInstitutions(symbol, request > 0, controller.signal, setProgress)
      .then(next => { if (!controller.signal.aborted) { setReport(next); setError(undefined); } })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load institutional ownership"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, symbol]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "r" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat || loading) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      setLoading(true); setError(undefined); setProgress(undefined); setRequest(value => value + 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [loading]);

  const refresh = () => {
    if (loading) return;
    setLoading(true); setError(undefined); setProgress(undefined); setRequest(value => value + 1);
  };
  const selectQuarter = (index: number) => { setQuarter(index); setPage(0); if (index === 0 && filter !== "all" && filter !== "tracked") setFilter("all"); };
  const toggleTracked = (id: string) => {
    setTracked(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(trackedKey, JSON.stringify([...next])); } catch { /* Tracking still works for this session. */ }
      return next;
    });
  };
  const selectSort = (next: Sort) => {
    setDescending(sort === next ? !descending : next !== "name"); setSort(next); setPage(0);
  };
  const funds = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = (report?.funds ?? []).filter(fund => {
      const point = fund.points[quarter];
      return (filter === "all" || (filter === "tracked" ? tracked.has(fund.id) : point?.status === filter))
        && (!query || `${fund.name} ${fund.registrant_name}`.toLowerCase().includes(query));
    });
    const metric = (fund: FundOwnership) => sort === "change" ? fund.points[quarter]?.change_percent ?? Number.NEGATIVE_INFINITY : fund.points[quarter]?.ownership_percent ?? Number.NEGATIVE_INFINITY;
    return rows.sort((a, b) => {
      const difference = sort === "name" ? a.name.localeCompare(b.name) : compare(metric(a), metric(b)) || (sort === "ownership" ? compare(a.points[quarter]?.shares ?? Number.NEGATIVE_INFINITY, b.points[quarter]?.shares ?? Number.NEGATIVE_INFINITY) : 0);
      return (descending ? -difference : difference) || a.name.localeCompare(b.name);
    });
  }, [report, quarter, filter, tracked, search, sort, descending]);

  const selected = report?.quarters[quarter];
  const previous = report?.quarters[quarter - 1];
  const netOwners = selected ? selected.new_owners - selected.exited_owners : 0;
  const trackedOwners = report?.funds.filter(fund => tracked.has(fund.id) && (fund.points[quarter]?.shares ?? 0) > 0).length ?? 0;
  const breadthChange = previous && selected ? selected.owners - previous.owners : undefined;
  const participation = selected ? selected.adding - selected.reducing : 0;
  const pageSize = 50;
  const safePage = Math.min(page, Math.max(0, Math.ceil(funds.length / pageSize) - 1));

  return <div className="institutions-tab">
    <div className="institutions-toolbar">
      <div className="institutions-heading"><span className="institutions-letter">I</span><div><h3>Institutional sponsorship</h3><p>{symbol} · Fund ownership across four reported quarters</p></div></div>
      <div className="institutions-toolbar-actions">
        {report && <span>History through {date(report.quarters[3].end_date)}</span>}
        <Tooltip title="Check SEC for source updates and read the history again (R)"><span><IconButton aria-label="Refresh institutions" disabled={loading} onClick={refresh}>{loading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}</IconButton></span></Tooltip>
      </div>
    </div>

    {loading && <ScanProgress progress={progress} initial={!report} />}
    {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={refresh} disabled={loading}>Retry</Button>}>{error}</Alert>}
    {report?.warnings.map(warning => <Alert key={warning} severity="warning" className="institutions-warning">{warning}</Alert>)}

    {report && report.matched_cusips.length === 0 && <p className="institutions-empty">Ownership could not be matched to this stock. The imported files cover {report.quarters[0]?.label}–{report.quarters[3]?.label}; no ownership or sponsorship conclusion is shown.</p>}
    {report && selected && report.matched_cusips.length > 0 && <>
      <div className="institutions-summary">
        <Summary label="Owning funds" value={integer.format(selected.owners)} detail={previous ? `${signed(selected.owners - previous.owners)} (${selected.owner_change_percent == null ? "—" : `${selected.owner_change_percent > 0 ? "+" : ""}${percent(selected.owner_change_percent)}`}) vs prior quarter` : "Reported fund sponsors"} />
        <Summary label="Reported fund ownership" value={`${selected.ownership_percent != null && selected.ownership_approximate ? "≈ " : ""}${percent(selected.ownership_percent)}`} detail="Common shares · N-PORT funds only" />
        <Summary label="Adding / reducing" value={report.splits_verified && quarter > 0 ? `${integer.format(selected.adding)} / ${integer.format(selected.reducing)}` : "—"} detail="Existing owners · split adjusted" />
        <Summary label="Tracked fund owners" value={integer.format(trackedOwners)} detail="Star the funds you follow" />
      </div>

      <section className="institutions-i-factor" aria-label="CAN SLIM institutional sponsorship factors">
        <div><span className="institutions-factor-label">Sponsor breadth</span><strong className={breadthChange == null || breadthChange === 0 ? "" : breadthChange > 0 ? "is-positive" : "is-negative"}>{breadthChange == null ? "Baseline quarter" : breadthChange > 0 ? "Increasing" : breadthChange < 0 ? "Decreasing" : "Unchanged"}</strong><small>{selected.increasing_quarters > 0 ? `${selected.increasing_quarters} consecutive quarterly ${selected.increasing_quarters === 1 ? "increase" : "increases"}` : "Compare the number of owning funds"}</small></div>
        <div><span className="institutions-factor-label">Existing sponsors</span><strong className={!report.splits_verified || quarter === 0 || participation === 0 ? "" : participation > 0 ? "is-positive" : "is-negative"}>{!report.splits_verified || quarter === 0 ? "Not assessed" : participation > 0 ? "More funds adding" : participation < 0 ? "More funds reducing" : "Balanced changes"}</strong><small>{quarter > 0 ? "Based on comparable, split-adjusted positions" : "Needs a previous quarterly position"}</small></div>
        <div><span className="institutions-factor-label">Sponsor quality</span><strong>Not rated</strong><small>Fund performance ratings are not supplied by SEC holdings files. Tracked funds are your selections.</small></div>
      </section>

      <div className="institutions-overview">
        <section className="institutions-chart" aria-label="Four-quarter fund sponsorship">
          <div className="institutions-section-title"><h4>Fund sponsorship</h4><span>Select a quarter to explore</span></div>
          <div className="institutions-bars">{report.quarters.map((item, index) => {
            const maximum = Math.max(1, ...report.quarters.map(q => q.owners));
            const change = index > 0 ? item.owners - report.quarters[index - 1].owners : undefined;
            return <button key={item.label} className={`institutions-bar${quarter === index ? " is-selected" : ""}`} aria-pressed={quarter === index} onClick={() => selectQuarter(index)}>
              <span className="institutions-bar-plot"><span className="institutions-bar-count">{integer.format(item.owners)}</span><span className="institutions-bar-fill" style={{ height: `${Math.max(2, item.owners / maximum * 100)}%` }} /></span>
              <strong>{item.label}</strong><span className={change == null || change === 0 ? "" : change > 0 ? "is-positive" : "is-negative"}>{change == null ? "Baseline" : `${signed(change)} owners`}</span>
            </button>;
          })}</div>
        </section>
        <section className="institutions-insight">
          <div className="institutions-section-title"><h4>{selected.label}</h4><span>{date(selected.end_date)}</span></div>
          <div className={`institutions-direction ${quarter > 0 && netOwners !== 0 ? netOwners > 0 ? "is-positive" : "is-negative" : ""}`}>
            {netOwners >= 0 ? <TrendingUpRoundedIcon /> : <TrendingDownRoundedIcon />}<h4>{quarter === 0 ? "Starting sponsorship" : netOwners > 0 ? "More funds entering" : netOwners < 0 ? "More funds exiting" : "Owner entries match exits"}</h4>
          </div>
          <div className="institutions-flows"><div><span>New owners</span><strong className="is-positive">{quarter > 0 ? integer.format(selected.new_owners) : "—"}</strong></div><div><span>Exited owners</span><strong className="is-negative">{quarter > 0 ? integer.format(selected.exited_owners) : "—"}</strong></div><div><span>Net new owners</span><strong>{quarter > 0 ? signed(netOwners) : "—"}</strong></div></div>
          <p>{quarter > 0 ? `${integer.format(selected.comparable)} comparable fund positions. New and exited owners are confirmed within this four-quarter window; missing filings are not exits.` : "Changes start with the next quarter, where a previous filing is available."}</p>
          <p className="institutions-coverage">{integer.format(selected.reporting_funds)} fund reports in this quarter · {integer.format(selected.unknown)} owner histories incomplete</p>
        </section>
      </div>

      <div className="institutions-table-toolbar">
        <div className="institutions-filters" aria-label="Fund filter">{filters.map(([value, label]) => <button key={value} aria-pressed={filter === value} disabled={quarter === 0 && value !== "all" && value !== "tracked"} className={filter === value ? "is-selected" : ""} onClick={() => { setFilter(value); setPage(0); }}>{label}</button>)}</div>
        <input aria-label="Search institutions" placeholder="Search funds or reporting entities…" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />
      </div>
      <p className="institutions-table-caption">Funds that owned {symbol} in at least one of these quarters. Percentages are company ownership; the share-change column compares reported positions.</p>
      <div className="institutions-table-scroll">
        <table className="institutions-table"><thead><tr>
          <th><button onClick={() => selectSort("name")}>Fund / reporting entity {sort === "name" ? descending ? "↓" : "↑" : ""}</button></th>
          {report.quarters.map((item, index) => <th key={item.label} className={quarter === index ? "is-selected" : ""}><button onClick={() => { if (quarter === index) selectSort("ownership"); else { selectQuarter(index); setSort("ownership"); setDescending(true); } }}>{item.label} {quarter === index && sort === "ownership" ? descending ? "↓" : "↑" : ""}</button><span>% of company</span></th>)}
          <th><button onClick={() => selectSort("change")}>Share change {sort === "change" ? descending ? "↓" : "↑" : ""}</button><span>{selected.label} vs prior</span></th><th>Position change</th>
        </tr></thead><tbody>{funds.slice(safePage * pageSize, (safePage + 1) * pageSize).map(fund => {
          const point = fund.points[quarter];
          return <Fragment key={fund.id}><tr>
            <td><div className="institutions-fund-name"><Tooltip title={tracked.has(fund.id) ? "Untrack fund" : "Track this fund"}><IconButton size="small" aria-label={`${tracked.has(fund.id) ? "Untrack" : "Track"} ${fund.name}`} aria-pressed={tracked.has(fund.id)} onClick={() => toggleTracked(fund.id)}>{tracked.has(fund.id) ? <StarRoundedIcon className="institutions-star" fontSize="small" /> : <StarOutlineRoundedIcon fontSize="small" />}</IconButton></Tooltip><button className="institutions-fund-expand" aria-expanded={expanded === fund.id} onClick={() => setExpanded(expanded === fund.id ? undefined : fund.id)}><span><strong>{fund.name}</strong><small>{fund.registrant_name}</small></span><ExpandMoreRoundedIcon className={expanded === fund.id ? "is-expanded" : ""} fontSize="small" /></button></div></td>
            {fund.points.map((position, index) => <td key={index} className={quarter === index ? "is-selected" : ""}><OwnershipCell position={position} /></td>)}
            <td className={point?.change_percent == null ? "" : point.change_percent > 0.01 ? "is-positive" : point.change_percent < -0.01 ? "is-negative" : ""}>{point?.change_percent == null ? "—" : `${point.change_percent > 0 ? "+" : ""}${percent(point.change_percent)}`}</td>
            <td><span className={`institutions-position is-${point?.status ?? "unknown"}`}>{point?.status === "unknown" && point.shares != null ? "No comparison" : statusLabel(point?.status)}</span></td>
          </tr>{expanded === fund.id && <tr className="institutions-expanded"><td colSpan={7}><div className="institutions-filing-grid">{fund.points.map((position, index) => <div key={index}><strong>{report.quarters[index].label}</strong>{position ? <><span>Held at {date(position.report_date)}</span><span>{position.shares == null ? "Position unconfirmed" : `${sharesFormat.format(position.shares)} shares`}</span><span>Company ownership {position.ownership_percent == null ? "unavailable" : `${position.approximate ? "≈ " : ""}${precise.format(position.ownership_percent)}%`}</span><span>Fund weight {position.portfolio_weight == null ? "—" : `${precise.format(position.portfolio_weight)}%`}</span>{position.denominator_date && <span>Share count as of {date(position.denominator_date)}</span>}<a href={position.filing_url} target="_blank" rel="noreferrer">Filed {date(position.filing_date)} <OpenInNewRoundedIcon /></a></> : <span>No filing available</span>}</div>)}</div></td></tr>}</Fragment>;
        })}</tbody></table>
        {funds.length === 0 && <p className="institutions-empty">{filter === "tracked" ? "Star funds to follow their sponsorship across quarters." : report.matched_cusips.length === 0 ? "No matching security identifier found in this history." : "No funds match this view."}</p>}
      </div>
      <div className="institutions-table-footer"><span>{funds.length > 0 ? `${integer.format(safePage * pageSize + 1)}–${integer.format(Math.min((safePage + 1) * pageSize, funds.length))} of ${integer.format(funds.length)} fund histories` : "0 funds"}</span><div><Button size="small" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</Button><Button size="small" disabled={(safePage + 1) * pageSize >= funds.length} onClick={() => setPage(safePage + 1)}>Next</Button></div></div>
      <p className="institutions-footnote"><a href={report.source_url} target="_blank" rel="noreferrer">SEC N-PORT</a> · Registered fund holdings; excludes other institutional managers. Fund reporting dates vary. ≈ uses a nearby reported share count. Starred funds are your tracked list, not a performance rating. <a href="https://shop.investors.com/images/promotional/20-Rules_102808.pdf" target="_blank" rel="noreferrer">CAN SLIM sponsorship guidance</a></p>
    </>}
  </div>;
}

function compare(a: number, b: number) { return a === b ? 0 : a > b ? 1 : -1; }
function statusLabel(status: FundPosition["status"] | undefined) {
  return status === "new" ? "New" : status === "added" ? "Added" : status === "reduced" ? "Reduced" : status === "exited" ? "Exited" : status === "unchanged" ? "Unchanged" : status === "baseline" ? "Baseline" : status == null ? "Missing filing" : "Unconfirmed";
}
function Summary({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="institutions-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
function OwnershipCell({ position }: { position: FundPosition | null }) {
  if (!position || position.shares == null) return <Tooltip title={position ? "The fund reported, but this position could not be confirmed" : "No fund filing available for this quarter"}><span className="institutions-cell institutions-unconfirmed"><span>—</span><small>{position ? "Unconfirmed" : "Missing filing"}</small></span></Tooltip>;
  const ownership = position.ownership_percent == null ? "—" : position.ownership_percent > 0 && position.ownership_percent < 0.01 ? "<0.01%" : percent(position.ownership_percent);
  return <Tooltip title={`${sharesFormat.format(position.shares)} shares held at ${date(position.report_date)}${position.ownership_percent != null ? `; ${precise.format(position.ownership_percent)}% of company` : ""}${position.denominator_date ? `; company shares reported ${date(position.denominator_date)}` : "; company ownership percentage unavailable"}`}><span className="institutions-cell"><span>{position.approximate ? "≈ " : ""}{ownership}</span><small>{compact.format(position.shares)} sh · {new Date(`${position.report_date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></span></Tooltip>;
}
function ScanProgress({ progress, initial }: { progress: OwnershipProgress | undefined; initial: boolean }) {
  const phase = progress?.phase;
  const title = phase === "queued" ? "Waiting for the current ownership request" : phase === "checking" ? "Checking fund history" : phase === "downloading" ? "Downloading ownership data" : phase === "scanning" ? "Reading fund disclosures" : phase === "calculating" ? "Calculating sponsorship" : "Loading institutions";
  const fraction = progress?.bytes_total ? Math.min(100, progress.bytes_received / progress.bytes_total * 100) : undefined;
  const transferred = progress?.bytes_received ? `${(progress.bytes_received / 1_000_000).toFixed(0)} MB${progress.bytes_total ? ` / ${(progress.bytes_total / 1_000_000).toFixed(0)} MB` : ""}` : "";
  return <div className={`institutions-loading${initial ? " is-initial" : ""}`} role="status" aria-live="polite"><div><CircularProgress size={18} /><strong>{title}</strong><span>{progress?.archive}{transferred ? ` · ${transferred}` : ""}</span></div><LinearProgress variant={fraction == null ? "indeterminate" : "determinate"} value={fraction} /><p>{phase === "scanning" ? `Archive ${(progress?.completed ?? 0) + 1} of ${progress?.total ?? 5}. Switch tabs or close the popup to cancel.` : phase === "downloading" ? "Source files are shared by all stocks. They are downloaded only when missing or updated." : initial ? "Saved fund history is read fresh for this stock. Source updates are checked at most once per day." : "Existing results remain visible until the new read finishes."}</p></div>;
}
