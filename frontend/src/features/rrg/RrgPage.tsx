import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircularProgress,
  Typography,
} from "@mui/material";
import { fetchThemeRrg, type ThemeRrgSeries } from "../../api/themes";
import { themesMarketWatchUrl } from "../ticker-lens/utils";
import { RrgControls } from "./RrgControls";
import { RrgSidePanel } from "./RrgSidePanel";
import { RrgThemeList } from "./RrgThemeList";
import { getRrgViewport } from "./rrgChart";
import {
  QUADRANTS,
  QUADRANT_ORDER,
  getQuadrant,
  type ExploreFilter,
  type Quadrant,
  type RrgItem,
} from "./rrgTypes";
import "./rrg.css";

export function RrgPage() {
  const [interval, setInterval] = useState<"daily" | "weekly">(
    () => (localStorage.getItem("rrg_interval") as "daily" | "weekly") || "daily"
  );
  const [lookbackDaily, setLookbackDaily] = useState(() =>
    parseInt(localStorage.getItem("rrg_lookback_daily") ?? "10", 10)
  );
  const [lookbackWeekly, setLookbackWeekly] = useState(() =>
    parseInt(localStorage.getItem("rrg_lookback_weekly") ?? "10", 10)
  );
  const lookback = interval === "daily" ? lookbackDaily : lookbackWeekly;
  const setLookback = interval === "daily" ? setLookbackDaily : setLookbackWeekly;
  const [tail, setTail] = useState(() =>
    parseInt(localStorage.getItem("rrg_tail") ?? "10", 10)
  );
  const [normalize, setNormalize] = useState(() =>
    localStorage.getItem("rrg_normalize") === "true"
  );
  const [series, setSeries] = useState<ThemeRrgSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [visible, setVisible] = useState<Record<number, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("rrg_visible") || "{}"); } catch { return {}; }
  });
  const [minRs, setMinRs] = useState<number | null>(() => {
    const v = localStorage.getItem("rrg_min_rs");
    return v === null ? null : parseFloat(v);
  });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exploredIds, setExploredIds] = useState<Set<number>>(new Set());
  const [exploreFilter, setExploreFilter] = useState<ExploreFilter>("unexplored");
  const [showExplored, setShowExplored] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const themeElements = useRef(new Map<number, HTMLElement>());

  const hoverIdxRef = useRef<number | null>(null);
  useEffect(() => { hoverIdxRef.current = hoverIdx; }, [hoverIdx]);

  // Persist
  useEffect(() => { try { localStorage.setItem("rrg_interval", interval); } catch {} }, [interval]);
  useEffect(() => { try { localStorage.setItem("rrg_lookback_daily", String(lookbackDaily)); } catch {} }, [lookbackDaily]);
  useEffect(() => { try { localStorage.setItem("rrg_lookback_weekly", String(lookbackWeekly)); } catch {} }, [lookbackWeekly]);
  useEffect(() => { try { localStorage.setItem("rrg_tail", String(tail)); } catch {} }, [tail]);
  useEffect(() => { try { localStorage.setItem("rrg_normalize", String(normalize)); } catch {} }, [normalize]);
  useEffect(() => {
    try {
      if (minRs === null) localStorage.removeItem("rrg_min_rs");
      else localStorage.setItem("rrg_min_rs", String(minRs));
    } catch {}
  }, [minRs]);
  useEffect(() => {
    try { localStorage.setItem("rrg_visible", JSON.stringify(visible)); } catch {}
  }, [visible]);

  const lookbackMin = interval === "daily" ? 5 : 5;
  const lookbackMax = interval === "daily" ? 60 : 20;
  useEffect(() => {
    setLookback((l) => Math.min(Math.max(l, lookbackMin), lookbackMax));
  }, [lookbackMin, lookbackMax]);

  // Debounced fetch
  const [debouncedLookback, setDebouncedLookback] = useState(lookback);
  const [debouncedTail, setDebouncedTail] = useState(tail);
  useEffect(() => { const t = setTimeout(() => setDebouncedLookback(lookback), 250); return () => clearTimeout(t); }, [lookback]);
  useEffect(() => { const t = setTimeout(() => setDebouncedTail(tail), 250); return () => clearTimeout(t); }, [tail]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchThemeRrg(interval, debouncedLookback, debouncedTail, normalize, controller.signal)
      .then((data) => {
        setSeries(data);
        setVisible((v) => {
          const next = { ...v };
          for (const s of data) if (next[s.theme_id] === undefined) next[s.theme_id] = true;
          return next;
        });
        setError(undefined);
      })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(String(e)); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [interval, debouncedLookback, debouncedTail, normalize]);

  const seriesById = useMemo(() => {
    const m = new Map<number, ThemeRrgSeries>();
    for (const s of series) m.set(s.theme_id, s);
    return m;
  }, [series]);

  const items: RrgItem[] = useMemo(() => {
    return series
      .filter((s) => visible[s.theme_id] !== false)
      .map((s) => {
        const last = s.points[s.points.length - 1];
        if (!last) return null;
        return { ...s, quadrant: getQuadrant(last.rs_ratio, last.rs_momentum), rsRatio: last.rs_ratio, rsMomentum: last.rs_momentum };
      })
      .filter((s): s is RrgItem => !!s)
      .filter((s) => minRs === null || s.rsRatio >= minRs)
      .filter((s) => exploreFilter === "all" || !exploredIds.has(s.theme_id));
  }, [series, visible, minRs, exploredIds, exploreFilter]);

  const rsValues = useMemo(() => items.map(i => i.rsRatio), [items]);
  const rsMin = rsValues.length ? Math.floor(Math.min(...rsValues) * 2) / 2 : 80;
  const rsMax = rsValues.length ? Math.ceil(Math.max(...rsValues) * 2) / 2 : 120;
  const rsSliderMin = Math.min(80, rsMin);
  const rsSliderMax = Math.max(120, rsMax);
  useEffect(() => {
    if (minRs !== null && (minRs < rsSliderMin || minRs > rsSliderMax)) setMinRs(null);
  }, [rsSliderMin, rsSliderMax, minRs]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W === 0 || H === 0) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { M, plotW, plotH, xMin, xMax, yMin, yMax, toX, toY } = getRrgViewport(items, W, H);
    if (plotW <= 0 || plotH <= 0) return;
    const cx = toX(100), cy = toY(100);

    ctx.fillStyle = "#111418"; ctx.fillRect(0, 0, W, H);

    const qFills = [
      { x: cx, y: M.top, w: M.left + plotW - cx, h: cy - M.top, q: QUADRANTS.leading },
      { x: M.left, y: M.top, w: cx - M.left, h: cy - M.top, q: QUADRANTS.improving },
      { x: M.left, y: cy, w: cx - M.left, h: M.top + plotH - cy, q: QUADRANTS.lagging },
      { x: cx, y: cy, w: M.left + plotW - cx, h: M.top + plotH - cy, q: QUADRANTS.weakening },
    ];
    qFills.forEach(({ x, y, w, h, q }) => { ctx.fillStyle = q.color; ctx.fillRect(x, y, w, h); });

    const span = Math.max(xMax - xMin, yMax - yMin);
    const gridStep = span > 30 ? 5 : span > 15 ? 2 : span > 6 ? 1 : 0.5;
    ctx.strokeStyle = "#2a3038"; ctx.lineWidth = 1; ctx.beginPath();
    for (let v = Math.ceil(xMin / gridStep) * gridStep; v <= xMax; v += gridStep) {
      const px = toX(v); ctx.moveTo(px, M.top); ctx.lineTo(px, M.top + plotH);
    }
    for (let v = Math.ceil(yMin / gridStep) * gridStep; v <= yMax; v += gridStep) {
      const py = toY(v); ctx.moveTo(M.left, py); ctx.lineTo(M.left + plotW, py);
    }
    ctx.stroke();

    ctx.strokeStyle = "#4a5563"; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(cx, M.top); ctx.lineTo(cx, M.top + plotH);
    ctx.moveTo(M.left, cy); ctx.lineTo(M.left + plotW, cy);
    ctx.stroke(); ctx.setLineDash([]);

    ctx.font = "600 10px -apple-system, sans-serif";
    const qLabels = [
      { text: "LEADING",   x: M.left + plotW - 8, y: M.top + 8,         align: "right" as const, color: QUADRANTS.leading.text,    baseline: "top" as const },
      { text: "IMPROVING", x: M.left + 8,         y: M.top + 8,         align: "left" as const,  color: QUADRANTS.improving.text,  baseline: "top" as const },
      { text: "LAGGING",   x: M.left + 8,         y: M.top + plotH - 8, align: "left" as const,  color: QUADRANTS.lagging.text,    baseline: "bottom" as const },
      { text: "WEAKENING", x: M.left + plotW - 8, y: M.top + plotH - 8, align: "right" as const, color: QUADRANTS.weakening.text,  baseline: "bottom" as const },
    ];
    qLabels.forEach(({ text, x, y, align, color, baseline }) => {
      ctx.textAlign = align; ctx.textBaseline = baseline; ctx.fillStyle = color; ctx.globalAlpha = 0.5;
      ctx.fillText(text, Math.round(x), Math.round(y)); ctx.globalAlpha = 1;
    });

    ctx.fillStyle = "#8f9aa7"; ctx.font = "10px -apple-system, sans-serif"; ctx.textBaseline = "top";
    for (let v = Math.ceil(xMin / gridStep) * gridStep; v <= xMax; v += gridStep) {
      const px = Math.round(toX(v)); ctx.textAlign = "center";
      ctx.fillText(v.toFixed(1), px, Math.round(M.top + plotH + 4));
    }
    ctx.textAlign = "right";
    for (let v = Math.ceil(yMin / gridStep) * gridStep; v <= yMax; v += gridStep) {
      const py = Math.round(toY(v)); ctx.textBaseline = "middle";
      ctx.fillText(v.toFixed(1), Math.round(M.left - 5), py);
    }
    ctx.fillStyle = "#8f9aa7"; ctx.font = "11px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("RS-Ratio →", Math.round(M.left + plotW / 2), Math.round(H - 2));
    ctx.save(); ctx.translate(Math.round(12), Math.round(M.top + plotH / 2)); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("RS-Momentum →", 0, 0); ctx.restore();

    ctx.beginPath(); ctx.arc(Math.round(cx), Math.round(cy), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#444"; ctx.fill();
    ctx.fillStyle = "#8f9aa7"; ctx.font = "10px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("Benchmark", Math.round(cx + 7), Math.round(cy));

    if (!items.length) {
      ctx.fillStyle = "#444"; ctx.font = "14px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(loading ? "Loading…" : "No themes", W / 2, H / 2);
      return;
    }

    items.forEach((d, idx) => {
      const isHovered = idx === hoverIdx;
      const isSelected = selectedIds.has(d.theme_id);
      const q = QUADRANTS[d.quadrant];
      const pts = d.points.map(p => ({ x: toX(p.rs_ratio), y: toY(p.rs_momentum) }));
      if (pts.length < 2) return;
      for (let i = 1; i < pts.length; i++) {
        const t = i / pts.length;
        const alpha = t * (isHovered || isSelected ? 0.85 : 0.45);
        const lw = 1 + t * (isHovered || isSelected ? 2.5 : 1.5);
        ctx.beginPath(); ctx.strokeStyle = q.dot; ctx.lineWidth = lw; ctx.globalAlpha = alpha; ctx.lineCap = "round";
        ctx.moveTo(pts[i-1].x, pts[i-1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    items.forEach((d, idx) => {
      const isHovered = idx === hoverIdx;
      const isSelected = selectedIds.has(d.theme_id);
      const q = QUADRANTS[d.quadrant];
      const x = toX(d.rsRatio), y = toY(d.rsMomentum);
      const r = isHovered || isSelected ? 5 : 3.5;
      if (isHovered || isSelected) {
        ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = q.dot; ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = q.dot; ctx.fill();
      ctx.fillStyle = isHovered || isSelected ? "#fff" : "#aeb7c2";
      ctx.font = `${isHovered || isSelected ? "600 " : ""}10px -apple-system, sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(d.etf_symbol, Math.round(x + r + 3), Math.round(y));
    });
  }, [items, hoverIdx, selectedIds, loading]);

  // Hit test
  const itemsRef = useRef<RrgItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const tooltip = tooltipRef.current;
    if (!canvas || !wrap || !tooltip) return;

    const handleMove = (e: MouseEvent) => {
      const items = itemsRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const W = wrap.clientWidth, H = wrap.clientHeight;
      const { toX, toY } = getRrgViewport(items, W, H);

      let hitIdx: number | null = null, hitDist = 12;
      items.forEach((d, idx) => {
        const x = toX(d.rsRatio), y = toY(d.rsMomentum);
        const dist = Math.hypot(mx - x, my - y);
        if (dist < hitDist) { hitDist = dist; hitIdx = idx; }
      });
      setHoverIdx(hitIdx);
      if (hitIdx !== null) {
        const d = items[hitIdx];
        tooltip.style.display = "block";
        tooltip.style.left = Math.min(mx + 12, W - 180) + "px";
        tooltip.style.top = Math.max(my - 10, 8) + "px";
        tooltip.innerHTML = `
          <div class="tt-name">${d.theme_name}</div>
          <div class="tt-etf">${d.etf_symbol}</div>
          <div class="tt-quad" style="color:${QUADRANTS[d.quadrant].text}">${QUADRANTS[d.quadrant].label}</div>
          <div class="tt-row">RS-Ratio <span class="tt-val">${d.rsRatio.toFixed(2)}</span></div>
          <div class="tt-row">RS-Momentum <span class="tt-val">${d.rsMomentum.toFixed(2)}</span></div>
        `;
        canvas.style.cursor = "pointer";
      } else {
        tooltip.style.display = "none";
        canvas.style.cursor = "default";
      }
    };
    const handleLeave = () => { setHoverIdx(null); if (tooltip) tooltip.style.display = "none"; };
    const handleClick = () => {
      const hoverIdx = hoverIdxRef.current;
      const items = itemsRef.current;
      if (hoverIdx !== null && items[hoverIdx]) {
        const id = items[hoverIdx].theme_id;
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      }
    };
    canvas.addEventListener("mousemove", handleMove);
    canvas.addEventListener("mouseleave", handleLeave);
    canvas.addEventListener("click", handleClick);
    return () => {
      canvas.removeEventListener("mousemove", handleMove);
      canvas.removeEventListener("mouseleave", handleLeave);
      canvas.removeEventListener("click", handleClick);
    };
  }, [items]);

  const toggleVisible = (id: number, v: boolean) => setVisible((prev) => ({ ...prev, [id]: v }));
  const toggleSelected = (id: number) => setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Scroll selected theme into view in left list + flash highlight
  const prevSelectedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const prev = prevSelectedRef.current;
    const added = [...selectedIds].filter(id => !prev.has(id));
    prevSelectedRef.current = new Set(selectedIds);
    if (added.length === 0) return;
    const lastId = added[added.length - 1];
    const el = themeElements.current.get(lastId);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el.classList.add("rrg-flash");
      const t = setTimeout(() => el.classList.remove("rrg-flash"), 900);
      return () => clearTimeout(t);
    }
  }, [selectedIds]);

  // Clear stale selections when series changes
  useEffect(() => {
    const validIds = new Set(series.map(s => s.theme_id));
    setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setExploredIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [series]);

  const markExplored = (ids: Iterable<number>, explored: boolean) => {
    setExploredIds((prev) => { const n = new Set(prev); for (const id of ids) { if (explored) n.add(id); else n.delete(id); } return n; });
    if (explored) setSelectedIds((prev) => { const n = new Set(prev); for (const id of ids) n.delete(id); return n; });
  };

  const selectedThemes = [...selectedIds]
    .map(id => seriesById.get(id))
    .filter(Boolean)
    .sort((a, b) => a!.theme_name.localeCompare(b!.theme_name)) as ThemeRrgSeries[];
  const exploredThemes = [...exploredIds]
    .map(id => seriesById.get(id))
    .filter(Boolean)
    .sort((a, b) => a!.theme_name.localeCompare(b!.theme_name)) as ThemeRrgSeries[];

  const openInMarketWatch = () => {
    if (!selectedThemes.length) return;
    window.open(themesMarketWatchUrl(selectedThemes.map(s => s.theme_name)), "_blank", "noopener,noreferrer");
  };

  const openAndMarkExplored = () => {
    if (!selectedThemes.length) return;
    openInMarketWatch();
    markExplored(selectedIds, true);
  };

  const listItems = useMemo(() => {
    return series
      .map((s) => {
        const last = s.points[s.points.length - 1];
        if (!last) return null;
        const quadrant = getQuadrant(last.rs_ratio, last.rs_momentum);
        const rsRatio = last.rs_ratio;
        return { ...s, quadrant, rsRatio };
      })
      .filter((s): s is ThemeRrgSeries & { quadrant: Quadrant; rsRatio: number } => !!s)
      .filter((s) => minRs === null || s.rsRatio >= minRs)
      .filter((s) => exploreFilter === "all" || !exploredIds.has(s.theme_id));
  }, [series, minRs, exploredIds, exploreFilter]);

  const groupedListItems = useMemo(() => {
    return QUADRANT_ORDER
      .map((quadrant) => ({
        quadrant,
        themes: listItems
          .filter((s) => s.quadrant === quadrant)
          .sort((a, b) => b.rsRatio - a.rsRatio || a.theme_name.localeCompare(b.theme_name)),
      }))
      .filter((group) => group.themes.length > 0);
  }, [listItems]);

  const allVisible = series.every((s) => visible[s.theme_id] !== false);
  const toggleAllVisible = () => {
    const nextVal = !allVisible;
    const next: Record<number, boolean> = {};
    for (const s of series) next[s.theme_id] = nextVal;
    setVisible(next);
  };
  const isQuadrantVisible = (quadrant: Quadrant) => {
    const themes = listItems.filter((s) => s.quadrant === quadrant);
    return themes.length > 0 && themes.every((s) => visible[s.theme_id] !== false);
  };
  const toggleQuadrantVisible = (quadrant: Quadrant) => {
    const themes = listItems.filter((s) => s.quadrant === quadrant);
    const nextVal = !themes.every((s) => visible[s.theme_id] !== false);
    setVisible((prev) => {
      const next = { ...prev };
      for (const s of themes) next[s.theme_id] = nextVal;
      return next;
    });
  };

  const exploredCount = exploredIds.size;
  const totalCount = series.length;

  return (
    <section className="theme-management-page">
      <header className="theme-management-header">
        <Typography component="h1">Relative Rotation Graph</Typography>
        <RrgControls
          interval={interval}
          lookback={lookback}
          lookbackMin={lookbackMin}
          lookbackMax={lookbackMax}
          tail={tail}
          minRs={minRs}
          rsSliderMin={rsSliderMin}
          rsSliderMax={rsSliderMax}
          normalize={normalize}
          onIntervalChange={setInterval}
          onLookbackChange={setLookback}
          onTailChange={setTail}
          onMinRsChange={setMinRs}
          onNormalizeChange={setNormalize}
          isQuadrantVisible={isQuadrantVisible}
          onToggleQuadrantVisible={toggleQuadrantVisible}
          onResetFilters={() => {
            setMinRs(null);
            setSelectedIds(new Set());
          }}
        />
      </header>

      <div className="theme-management-body rrg-body">
        <RrgThemeList
          groups={groupedListItems}
          visible={visible}
          selectedIds={selectedIds}
          exploredIds={exploredIds}
          exploreFilter={exploreFilter}
          itemCount={items.length}
          totalCount={totalCount}
          allVisible={allVisible}
          onExploreFilterChange={setExploreFilter}
          onToggleAllVisible={toggleAllVisible}
          onToggleVisible={toggleVisible}
          onThemeElement={(themeId, element) => {
            if (element) themeElements.current.set(themeId, element);
            else themeElements.current.delete(themeId);
          }}
        />

        {/* Center: chart */}
        <main className="rrg-main">
          <div className="rrg-canvas-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} />
            <div id="rrg-tooltip" ref={tooltipRef} />
            {loading && (
              <div className="rrg-overlay">
                <CircularProgress size="1rem" />
                <Typography color="text.secondary">Loading Relative Rotation Graph</Typography>
              </div>
            )}
            {error && (
              <div className="rrg-error">
                <Typography color="error">{error}</Typography>
              </div>
            )}
          </div>
        </main>

        <RrgSidePanel
          selectedIds={selectedIds}
          selectedThemes={selectedThemes}
          exploredThemes={exploredThemes}
          exploredCount={exploredCount}
          totalCount={totalCount}
          showExplored={showExplored}
          onOpenAndMarkExplored={openAndMarkExplored}
          onOpenSelected={openInMarketWatch}
          onMarkSelectedExplored={() => markExplored(selectedIds, true)}
          onClearSelected={() => setSelectedIds(new Set())}
          onToggleSelected={toggleSelected}
          onShowExploredChange={setShowExplored}
          onClearExplored={() => setExploredIds(new Set())}
          onUnmarkExplored={(themeId) => markExplored([themeId], false)}
        />
      </div>
    </section>
  );
}
