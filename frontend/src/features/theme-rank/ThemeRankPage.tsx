import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, CircularProgress, MenuItem, Select, TextField, Typography } from "@mui/material";
import { fetchThemeRankings, type PerformancePeriods, type ThemeRanking } from "../../api/industries";
import { fetchThemes } from "../../api/themes";
import { Toast } from "../../components/Toast";
import "./theme-rank.css";

const horizons = ["half_year", "quarter", "month", "week"] as const;
type Horizon = (typeof horizons)[number];

const horizonLabels: Record<Horizon, string> = {
  half_year: "6M",
  quarter: "3M",
  month: "1M",
  week: "1W",
};

type RankedTheme = ThemeRanking & { ranks?: Record<Horizon, number> };
const highlightedThemesStorageKey = "market-watch.theme-rank.highlighted-themes";

export function ThemeRankPage() {
  const [themes, setThemes] = useState<ThemeRanking[]>([]);
  const [highlightedIds, setHighlightedIds] = useState(readHighlightedIds);
  const [topCount, setTopCount] = useState(10);
  const [presetHorizon, setPresetHorizon] = useState<Horizon | undefined>(() =>
    localStorage.getItem(highlightedThemesStorageKey) === null ? "week" : undefined,
  );
  const [search, setSearch] = useState("");
  const [hoveredId, setHoveredId] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const initializedSelection = useRef(localStorage.getItem(highlightedThemesStorageKey) !== null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([fetchThemes(controller.signal), fetchThemeRankings(controller.signal)])
      .then(([metadata, rankings]) => {
        if (controller.signal.aborted) return;
        const byId = new Map(rankings.map((theme) => [theme.id, theme]));
        setThemes(metadata.map((theme) => byId.get(theme.id) ?? {
          id: theme.id,
          name: theme.name,
          etf_symbol: theme.etf_symbol,
          performance: null,
          relative_strength: null,
        }));
      })
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

  const rankedThemes = useMemo(() => rankThemes(themes), [themes]);
  const eligibleThemes = useMemo(
    () => rankedThemes.filter((theme) => theme.ranks !== undefined),
    [rankedThemes],
  );
  const visibleHighlightedIds = useMemo(() => {
    const eligibleIds = new Set(eligibleThemes.map((theme) => theme.id));
    return new Set([...highlightedIds].filter((id) => eligibleIds.has(id)));
  }, [eligibleThemes, highlightedIds]);
  const topTenIds = useMemo(
    () => Object.fromEntries(horizons.map((horizon) => [
      horizon,
      [...eligibleThemes]
        .sort((left, right) => (left.ranks?.[horizon] ?? 0) - (right.ranks?.[horizon] ?? 0))
        .slice(0, topCount)
        .map((theme) => theme.id),
    ])) as Record<Horizon, number[]>,
    [eligibleThemes, topCount],
  );

  useEffect(() => {
    if (initializedSelection.current || loading || rankedThemes.length === 0) return;
    initializedSelection.current = true;
    setHighlightedIds(new Set(topTenIds.week));
  }, [loading, rankedThemes.length, topTenIds]);

  useEffect(() => {
    if (!initializedSelection.current || presetHorizon === undefined) return;
    setHighlightedIds(new Set(topTenIds[presetHorizon]));
  }, [presetHorizon, topTenIds]);

  useEffect(() => {
    if (!initializedSelection.current) return;
    localStorage.setItem(highlightedThemesStorageKey, JSON.stringify([...highlightedIds]));
  }, [highlightedIds]);

  const normalizedSearch = search.trim().toLowerCase();
  const visibleList = rankedThemes.filter((theme) =>
    normalizedSearch.length === 0 ||
    theme.name.toLowerCase().includes(normalizedSearch) ||
    theme.etf_symbol.toLowerCase().includes(normalizedSearch),
  );

  return (
    <section className="theme-rank-page">
      <aside className="workspace-panel theme-rank-sidebar">
        <header className="theme-rank-sidebar-header">
          <TextField
            size="small"
            value={search}
            placeholder="Search themes"
            onChange={(event) => setSearch(event.target.value)}
            slotProps={{ htmlInput: { "aria-label": "Search themes" } }}
          />
          <div className="theme-rank-selection-actions">
            <Select
              size="small"
              value={topCount}
              aria-label="Number of top-ranked themes to highlight"
              onChange={(event) => setTopCount(Number(event.target.value))}
            >
              {[10, 15, 20, 30].map((count) => <MenuItem key={count} value={count}>{count}</MenuItem>)}
            </Select>
            {horizons.map((horizon) => (
              <Button
                key={horizon}
                size="small"
                variant={presetHorizon === horizon ? "contained" : "text"}
                title={`Highlight top ${topCount} by ${horizonLabels[horizon]} rank`}
                onClick={() => {
                  setPresetHorizon(horizon);
                  setHighlightedIds(new Set(topTenIds[horizon]));
                }}
              >{horizonLabels[horizon]}</Button>
            ))}
            <Button size="small" onClick={() => { setPresetHorizon(undefined); setHighlightedIds(new Set(eligibleThemes.map((theme) => theme.id))); }}>All</Button>
            <Button size="small" onClick={() => { setPresetHorizon(undefined); setHighlightedIds(new Set()); }}>Clear</Button>
          </div>
        </header>
        {loading && themes.length === 0 ? (
          <div className="panel-status"><CircularProgress size="1rem" /></div>
        ) : (
          <ol className="theme-rank-theme-list">
            {visibleList.map((theme) => {
              const eligible = theme.ranks !== undefined;
              return (
                <li key={theme.id}>
                  <label className="theme-rank-theme-row">
                    <Checkbox
                      size="small"
                      checked={highlightedIds.has(theme.id)}
                      disabled={!eligible}
                      onChange={() => {
                        setPresetHorizon(undefined);
                        setHighlightedIds((current) => toggleId(current, theme.id));
                      }}
                    />
                    <span
                      className="theme-rank-color"
                      style={{ backgroundColor: eligible ? themeColor(theme.id) : "transparent" }}
                    />
                    <span className="theme-rank-theme-name" title={`${theme.name} (${theme.etf_symbol})`}>
                      {theme.name} <small>{theme.etf_symbol}</small>
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>
        )}
      </aside>
      <main className="theme-rank-chart-panel">
        <header className="theme-rank-chart-header">
          {horizons.map((horizon) => <span key={horizon}>{horizonLabels[horizon]}</span>)}
        </header>
        <div className="theme-rank-chart-scroll">
          {eligibleThemes.length === 0 ? (
            <Typography className="theme-rank-empty" color="text.secondary">
              No themes have complete ranking data
            </Typography>
          ) : (
            <RankChart
              themes={eligibleThemes}
              hoveredId={hoveredId}
              highlightedIds={visibleHighlightedIds}
              onHover={setHoveredId}
              onToggleHighlight={(id) => {
                setPresetHorizon(undefined);
                setHighlightedIds((current) => toggleId(current, id));
              }}
            />
          )}
        </div>
      </main>
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function RankChart({
  themes,
  hoveredId,
  highlightedIds,
  onHover,
  onToggleHighlight,
}: {
  themes: RankedTheme[];
  hoveredId?: number;
  highlightedIds: Set<number>;
  onHover: (id?: number) => void;
  onToggleHighlight: (id: number) => void;
}) {
  const width = 1000;
  const height = Math.max(600, themes.length * 14 + 20);
  const listTop = 8;
  const rowPitch = 14;
  const columnWidth = width / horizons.length;
  const boxWidth = 108;
  const boxHeight = 9;
  const x = (index: number) => columnWidth * index + columnWidth / 2;
  const positions = new Map<string, number>();
  horizons.forEach((horizon) => {
    const sorted = [...themes].sort((left, right) =>
      (left.ranks?.[horizon] ?? Number.POSITIVE_INFINITY) -
      (right.ranks?.[horizon] ?? Number.POSITIVE_INFINITY),
    );
    sorted.forEach((theme, index) => {
      const y = listTop + index * rowPitch;
      positions.set(`${horizon}:${theme.id}`, y);
    });
  });
  const orderedThemes = [...themes].sort((left, right) => {
    const priority = (theme: RankedTheme) => hoveredId === theme.id
      ? 2
      : highlightedIds.has(theme.id) ? 1 : 0;
    return priority(left) - priority(right);
  });

  return (
    <svg className="theme-rank-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Theme rank flow chart">
      <defs>
        {themes.map((theme) => (
          <marker key={theme.id} id={`theme-rank-arrow-${theme.id}`} markerWidth="3" markerHeight="3" refX="2.7" refY="1.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L3,1.5 L0,3 Z" fill={themeColor(theme.id)} />
          </marker>
        ))}
      </defs>
      {horizons.slice(1).map((horizon, index) =>
        <line key={horizon} className="theme-rank-column" x1={columnWidth * (index + 1)} x2={columnWidth * (index + 1)} y1="0" y2={height} />
      )}
      {orderedThemes.map((theme) => {
        if (theme.ranks === undefined) return null;
        const color = themeColor(theme.id);
        const hovered = hoveredId === theme.id;
        const selected = highlightedIds.has(theme.id);
        const active = hovered || selected;
        const dimmed = !active;
        return <g
          key={theme.id}
          className="theme-rank-line"
          style={{ filter: hovered ? `drop-shadow(0 0 ${selected ? 2.5 : 1.5}px ${color})` : undefined }}
          role="button"
          tabIndex={0}
          aria-label={`${theme.name}, 1 week rank ${formatRank(theme.ranks.week)}`}
          onMouseEnter={() => onHover(theme.id)}
          onMouseLeave={() => onHover(undefined)}
          onFocus={() => onHover(theme.id)}
          onBlur={() => onHover(undefined)}
          onClick={() => onToggleHighlight(theme.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggleHighlight(theme.id);
            }
          }}
        >
          {horizons.slice(0, -1).map((horizon, index) => {
            const nextHorizon = horizons[index + 1];
            const startY = positions.get(`${horizon}:${theme.id}`) ?? 0;
            const endY = positions.get(`${nextHorizon}:${theme.id}`) ?? 0;
            const startX = x(index) + boxWidth / 2;
            const endX = x(index + 1) - boxWidth / 2 - 2.5;
            const control = (startX + endX) / 2;
            const path = `M ${startX} ${startY} C ${control} ${startY}, ${control} ${endY}, ${endX} ${endY}`;
            return <g key={horizon}>
              <path d={path} fill="none" stroke="transparent" strokeWidth="6" />
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={hovered ? 1.2 : selected ? 0.8 : 0.4}
                opacity={dimmed ? 0.1 : hovered ? 1 : 0.82}
                markerEnd={`url(#theme-rank-arrow-${theme.id})`}
                pointerEvents="none"
              />
            </g>;
          })}
          {horizons.map((horizon, index) => {
            const centerY = positions.get(`${horizon}:${theme.id}`) ?? 0;
            return <g key={horizon} opacity={dimmed ? 0.18 : 1}>
              <rect
                className="theme-rank-ticker-box"
                x={x(index) - boxWidth / 2}
                y={centerY - boxHeight / 2}
                width={boxWidth}
                height={boxHeight}
                rx="4"
                stroke={color}
                strokeWidth={hovered ? 1 : selected ? 0.65 : 0.35}
              />
              <text className="theme-rank-ticker-label" x={x(index) - boxWidth / 2 + 9} y={centerY} dominantBaseline="middle">
                {compactThemeName(theme.name)}
              </text>
              <text className="theme-rank-ticker-rank" x={x(index) + boxWidth / 2 - 9} y={centerY} textAnchor="end" dominantBaseline="middle">
                #{formatRank(theme.ranks![horizon])}
              </text>
            </g>;
          })}
        </g>;
      })}
    </svg>
  );
}

function rankThemes(themes: ThemeRanking[]): RankedTheme[] {
  const eligible = themes.filter((theme) =>
    theme.performance !== null && horizons.every((horizon) => Number.isFinite(theme.performance?.[horizon])),
  );
  const ranksByTheme = new Map<number, Partial<Record<Horizon, number>>>();
  for (const horizon of horizons) {
    const sorted = [...eligible].sort((left, right) =>
      (right.performance?.[horizon] ?? 0) - (left.performance?.[horizon] ?? 0),
    );
    let index = 0;
    while (index < sorted.length) {
      let end = index + 1;
      const value = sorted[index].performance?.[horizon];
      while (end < sorted.length && sorted[end].performance?.[horizon] === value) end += 1;
      const rank = (index + 1 + end) / 2;
      for (const theme of sorted.slice(index, end)) {
        const ranks = ranksByTheme.get(theme.id) ?? {};
        ranks[horizon] = rank;
        ranksByTheme.set(theme.id, ranks);
      }
      index = end;
    }
  }
  return themes
    .map((theme): RankedTheme => {
      const ranks = ranksByTheme.get(theme.id);
      return ranks === undefined ? theme : { ...theme, ranks: ranks as Record<Horizon, number> };
    })
    .sort((left, right) => {
      if (left.ranks === undefined) return right.ranks === undefined ? left.name.localeCompare(right.name) : 1;
      if (right.ranks === undefined) return -1;
      return left.ranks.week - right.ranks.week || left.name.localeCompare(right.name);
    });
}

function toggleId(current: Set<number>, id: number) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function themeColor(id: number) {
  return `hsl(${(id * 137.508) % 360} 72% 60%)`;
}

function formatRank(rank: number) {
  return Number.isInteger(rank) ? String(rank) : rank.toFixed(1);
}

function compactThemeName(name: string) {
  return name.length <= 14 ? name : `${name.slice(0, 13)}…`;
}

function readHighlightedIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(highlightedThemesStorageKey) ?? "[]") as unknown;
    return new Set(
      Array.isArray(stored)
        ? stored.filter((value): value is number => Number.isSafeInteger(value))
        : [],
    );
  } catch {
    return new Set<number>();
  }
}
