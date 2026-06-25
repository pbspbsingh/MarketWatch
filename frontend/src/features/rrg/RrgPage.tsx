import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { fetchThemeRrg, type ThemeRrgSeries } from "../../api/themes";
import { themesMarketWatchUrl } from "../ticker-lens/utils";

type Quadrant = "leading" | "weakening" | "lagging" | "improving";

const QUADRANTS = {
  leading:    { label: "Leading",    color: "rgba(40,180,80,0.09)",  dot: "#2ecc71", text: "#2ecc71" },
  weakening:  { label: "Weakening",  color: "rgba(243,156,18,0.09)", dot: "#f39c12", text: "#f39c12" },
  lagging:    { label: "Lagging",    color: "rgba(220,50,50,0.09)",  dot: "#e74c3c", text: "#e74c3c" },
  improving:  { label: "Improving",  color: "rgba(74,158,255,0.09)", dot: "#4a9eff", text: "#4a9eff" },
} as const;

function getQuadrant(rsRatio: number, rsMomentum: number): Quadrant {
  if (rsRatio >= 100 && rsMomentum >= 100) return "leading";
  if (rsRatio >= 100 && rsMomentum <  100) return "weakening";
  if (rsRatio <  100 && rsMomentum <  100) return "lagging";
  return "improving";
}

type RrgItem = ThemeRrgSeries & { quadrant: Quadrant; rsRatio: number; rsMomentum: number };
type ExploreFilter = "unexplored" | "all";

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
  const [quadrants, setQuadrants] = useState<Record<Quadrant, boolean>>(() => {
    try {
      const hidden: Quadrant[] = JSON.parse(localStorage.getItem("rrg_hidden_quads") || "[]");
      return {
        leading: !hidden.includes("leading"),
        weakening: !hidden.includes("weakening"),
        lagging: !hidden.includes("lagging"),
        improving: !hidden.includes("improving"),
      };
    } catch {
      return { leading: true, weakening: true, lagging: true, improving: true };
    }
  });
  const [minRs, setMinRs] = useState<number | null>(() => {
    const v = localStorage.getItem("rrg_min_rs");
    return v === null ? null : parseFloat(v);
  });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exploredIds, setExploredIds] = useState<Set<number>>(new Set());
  const [exploreFilter, setExploreFilter] = useState<ExploreFilter>("unexplored");

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
    try {
      const hidden = (Object.entries(quadrants) as [Quadrant, boolean][])
        .filter(([, v]) => !v).map(([k]) => k);
      localStorage.setItem("rrg_hidden_quads", JSON.stringify(hidden));
    } catch {}
  }, [quadrants]);
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
      .filter((s) => quadrants[s.quadrant])
      .filter((s) => minRs === null || s.rsRatio >= minRs)
      .filter((s) => exploreFilter === "all" || !exploredIds.has(s.theme_id));
  }, [series, visible, quadrants, minRs, exploredIds, exploreFilter]);

  const rsValues = useMemo(() => items.map(i => i.rsRatio), [items]);
  const rsMin = rsValues.length ? Math.floor(Math.min(...rsValues) * 2) / 2 : 80;
  const rsMax = rsValues.length ? Math.ceil(Math.max(...rsValues) * 2) / 2 : 120;
  const rsSliderMin = Math.min(80, rsMin);
  const rsSliderMax = Math.max(120, rsMax);
  useEffect(() => {
    if (minRs !== null && (minRs < rsSliderMin || minRs > rsSliderMax)) setMinRs(null);
  }, [rsSliderMin, rsSliderMax, minRs]);

  const getViewport = (width: number, height: number) => {
    const M = { top: 36, right: 36, bottom: 44, left: 52 };
    const plotW = width - M.left - M.right;
    const plotH = height - M.top - M.bottom;
    let xMin = 95, xMax = 105, yMin = 95, yMax = 105;
    if (items.length) {
      const xs = items.flatMap(d => d.points.map(p => p.rs_ratio));
      const ys = items.flatMap(d => d.points.map(p => p.rs_momentum));
      const allX = [...xs, 100], allY = [...ys, 100];
      xMin = Math.min(...allX); xMax = Math.max(...allX);
      yMin = Math.min(...allY); yMax = Math.max(...allY);
      const padX = Math.max((xMax - xMin) * 0.1, 1.5);
      const padY = Math.max((yMax - yMin) * 0.1, 1.5);
      xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;
      if (xMin > 100) xMin = 99; if (xMax < 100) xMax = 101;
      if (yMin > 100) yMin = 99; if (yMax < 100) yMax = 101;
    }
    const toX = (v: number) => M.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const toY = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    return { M, plotW, plotH, xMin, xMax, yMin, yMax, toX, toY };
  };

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

    const { M, plotW, plotH, xMin, xMax, yMin, yMax, toX, toY } = getViewport(W, H);
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
      const M = { top: 36, right: 36, bottom: 44, left: 52 };
      const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
      let xMin = 95, xMax = 105, yMin = 95, yMax = 105;
      if (items.length) {
        const xs = items.flatMap(d => d.points.map(p => p.rs_ratio));
        const ys = items.flatMap(d => d.points.map(p => p.rs_momentum));
        const allX = [...xs, 100], allY = [...ys, 100];
        xMin = Math.min(...allX); xMax = Math.max(...allX);
        yMin = Math.min(...allY); yMax = Math.max(...allY);
        const padX = Math.max((xMax - xMin) * 0.1, 1.5);
        const padY = Math.max((yMax - yMin) * 0.1, 1.5);
        xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;
        if (xMin > 100) xMin = 99; if (xMax < 100) xMax = 101;
        if (yMin > 100) yMin = 99; if (yMax < 100) yMax = 101;
      }
      const toX = (v: number) => M.left + ((v - xMin) / (xMax - xMin)) * plotW;
      const toY = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

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
      .filter((s) => quadrants[s.quadrant])
      .filter((s) => minRs === null || s.rsRatio >= minRs)
      .filter((s) => exploreFilter === "all" || !exploredIds.has(s.theme_id))
      .sort((a, b) => a.theme_name.localeCompare(b.theme_name));
  }, [series, quadrants, minRs, exploredIds, exploreFilter]);

  const allVisible = series.every((s) => visible[s.theme_id] !== false);
  const toggleAllVisible = () => {
    const nextVal = !allVisible;
    const next: Record<number, boolean> = {};
    for (const s of series) next[s.theme_id] = nextVal;
    setVisible(next);
  };

  const exploredCount = exploredIds.size;
  const totalCount = series.length;

  return (
    <section className="theme-management-page">
      <style>{`
        #rrg-tooltip { position: absolute; pointer-events: none; background: rgba(20,20,20,0.92); border: 1px solid #3a3a3a; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #e0e0e0; display: none; white-space: nowrap; z-index: 10; line-height: 1.7; }
        #rrg-tooltip .tt-name { font-weight: 700; color: #fff; font-size: 13px; }
        #rrg-tooltip .tt-etf  { font-size: 10px; color: #666; }
        #rrg-tooltip .tt-quad { font-size: 11px; margin-top: 2px; }
        #rrg-tooltip .tt-row  { display: flex; justify-content: space-between; gap: 16px; }
        #rrg-tooltip .tt-val  { color: #4a9eff; font-weight: 600; }
        .rrg-canvas-wrap { flex: 1; min-height: 0; position: relative; overflow: hidden; }
        .rrg-canvas-wrap canvas { display: block; width: 100%; height: 100%; }
        .rrg-right-pane {
          display: flex; flex-direction: column; gap: 0.75rem;
          padding: 0.5rem; border-left: 1px solid #2a3038; background: #151a20;
          overflow: hidden;
        }
        .rrg-right-pane h3 {
          margin: 0; font-size: 0.68rem; text-transform: uppercase; color: #8f9aa7; letter-spacing: 0.04em;
        }
        .rrg-right-section {
          display: flex; flex-direction: column; gap: 0.35rem;
          padding-bottom: 0.75rem; border-bottom: 1px solid #2a3038;
        }
        .rrg-right-section:last-child { border-bottom: none; }
        .rrg-mini-list { max-height: 14rem; overflow: auto; font-size: 0.7rem; }
        .rrg-mini-row { display: flex; align-items: center; gap: 0.35rem; padding: 2px 0; color: #aeb7c2; }
        .rrg-mini-row button { border: none; background: transparent; color: #8f9aa7; cursor: pointer; font-size: 0.65rem; }
        .rrg-mini-row button:hover { color: #d7dce2; }
        /* Match TickerLens ranked-list-item-context */
        .rrg-list-row { border-radius: 3px; }
        .rrg-list-row.selected { box-shadow: inset 0.1875rem 0 0 #f5a524; background: rgba(245,165,36,0.10); }
        @keyframes rrg-flash-bg { 0% { background: rgba(245,165,36,0.25); } 100% { background: rgba(245,165,36,0.10); } }
        .rrg-flash { animation: rrg-flash-bg 0.9s ease-out; }
        .rrg-flash.selected { box-shadow: inset 0.1875rem 0 0 #f5a524; }
      `}</style>

      <header className="theme-management-header">
        <Typography component="h1">Relative Rotation Graph</Typography>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginLeft: "auto", flexWrap: "wrap" }}>
          <ToggleButtonGroup value={interval} exclusive size="small" onChange={(_, v) => v && setInterval(v)}>
            <ToggleButton value="daily" style={{ fontSize: "0.65rem", padding: "0.2rem 0.6rem" }}>Daily</ToggleButton>
            <ToggleButton value="weekly" style={{ fontSize: "0.65rem", padding: "0.2rem 0.6rem" }}>Weekly</ToggleButton>
          </ToggleButtonGroup>
          <div style={{ width: 120 }}>
            <Typography variant="caption" sx={{ fontSize: "0.6rem", textTransform: "uppercase", color: "#8f9aa7" }}>Lookback: {lookback}</Typography>
            <Slider min={lookbackMin} max={lookbackMax} value={lookback} onChange={(_, v) => setLookback(v as number)} size="small" sx={{ padding: "6px 0" }} />
          </div>
          <div style={{ width: 100 }}>
            <Typography variant="caption" sx={{ fontSize: "0.6rem", textTransform: "uppercase", color: "#8f9aa7" }}>Tail: {tail}</Typography>
            <Slider min={1} max={50} value={tail} onChange={(_, v) => setTail(v as number)} size="small" sx={{ padding: "6px 0" }} />
          </div>
          <div style={{ width: 110 }}>
            <Typography variant="caption" sx={{ fontSize: "0.6rem", textTransform: "uppercase", color: "#8f9aa7" }}>RS ≥ {minRs === null ? "—" : minRs.toFixed(1)}</Typography>
            <Slider min={rsSliderMin} max={rsSliderMax} step={0.5} value={minRs ?? rsSliderMin} onChange={(_, v) => setMinRs(v as number)} size="small" sx={{ padding: "6px 0" }} />
          </div>
          <FormControlLabel control={<Checkbox size="small" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} sx={{ padding: "2px", color: "#8f9aa7", "&.Mui-checked": { color: "#58a6ff" } }} />} label={<span style={{ fontSize: "0.65rem", color: "#aeb7c2" }}>Normalize</span>} sx={{ margin: 0, marginRight: 1 }} />
          <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
            {(["leading", "improving", "lagging", "weakening"] as Quadrant[]).map((q) => {
              const active = quadrants[q];
              return (
                <button key={q} onClick={() => setQuadrants({ ...quadrants, [q]: !active })}
                  style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "3px 7px", border: "1px solid #333", borderRadius: "4px", background: "#1a1a1a", color: active ? "#ccc" : "#777", fontSize: "11px", fontWeight: 600, cursor: "pointer", opacity: active ? 1 : 0.35, textDecoration: active ? "none" : "line-through" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: QUADRANTS[q].dot, flexShrink: 0 }} />
                  {q.charAt(0).toUpperCase() + q.slice(1)}
                </button>
              );
            })}
            <button onClick={() => { setMinRs(null); setSelectedIds(new Set()); }} style={{ padding: "3px 8px", border: "1px solid #3a3a3a", background: "transparent", color: "#666", fontSize: "11px", cursor: "pointer", borderRadius: "3px" }} title="Reset filters">↺</button>
          </div>
        </div>
      </header>

      <div className="theme-management-body" style={{ gridTemplateColumns: "20rem minmax(0, 1fr) 18rem" }}>
        {/* Left: visibility list */}
        <aside className="theme-list-pane">
          <div className="theme-pane-header">
            <Typography component="h2">Themes ({items.length}/{totalCount})</Typography>
            <button onClick={toggleAllVisible} style={{ background: "transparent", border: "none", color: "#58a6ff", cursor: "pointer", fontSize: "0.65rem" }}>
              {allVisible ? "None" : "All"}
            </button>
          </div>
          <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
            {listItems.map((s) => {
              const isVisible = visible[s.theme_id] !== false;
              const isExplored = exploredIds.has(s.theme_id);
              const isSelected = selectedIds.has(s.theme_id);
              return (
                <div
                  key={s.theme_id}
                  ref={(el) => {
                    if (el) themeElements.current.set(s.theme_id, el);
                    else themeElements.current.delete(s.theme_id);
                  }}
                  className={`rrg-list-row${isSelected ? " selected" : ""}`}
                >
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={isVisible}
                      onChange={(e) => toggleVisible(s.theme_id, e.target.checked)}
                      sx={{ padding: "2px", color: "#8f9aa7", "&.Mui-checked": { color: "#58a6ff" } }}
                    />
                  }
                  label={
                    <span style={{ fontSize: "0.72rem", opacity: isExplored ? 0.5 : 1, color: isSelected ? "#f0f4f8" : undefined }}>
                      {s.theme_name} <span style={{ color: "#8f9aa7", fontSize: "0.625rem" }}>· {s.etf_symbol}</span>
                      {isExplored && <span style={{ marginLeft: 4, fontSize: "0.6rem", color: "#8f9aa7" }}>✓</span>}
                    </span>
                  }
                  sx={{ display: "flex", margin: 0, padding: "0.15rem 0" }}
                />
                </div>
              );
            })}
          </div>
        </aside>

        {/* Center: chart */}
        <main style={{ padding: "0.75rem", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          <div className="rrg-canvas-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} />
            <div id="rrg-tooltip" ref={tooltipRef} />
            {loading && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", background: "rgba(17,20,24,0.7)", zIndex: 5 }}>
                <CircularProgress size="1rem" />
                <Typography color="text.secondary" sx={{ fontSize: "0.75rem" }}>Loading RRG</Typography>
              </div>
            )}
            {error && (
              <div style={{ position: "absolute", top: "0.5rem", left: "0.5rem", right: "0.5rem", zIndex: 5 }}>
                <Typography color="error" sx={{ fontSize: "0.75rem" }}>{error}</Typography>
              </div>
            )}
          </div>
        </main>

        {/* Right: selection / explored */}
        <aside className="rrg-right-pane">
          <div className="rrg-right-section">
            <h3>Selected ({selectedIds.size})</h3>
            {selectedThemes.length === 0 ? (
              <span style={{ fontSize: "0.7rem", color: "#8f9aa7" }}>Click dots in the chart to select.</span>
            ) : (
              <>
                <div className="rrg-mini-list">
                  {selectedThemes.map(t => (
                    <div key={t.theme_id} className="rrg-mini-row">
                      <span style={{ flex: 1 }}>{t.theme_name} <span style={{ color: "#8f9aa7" }}>· {t.etf_symbol}</span></span>
                      <button onClick={() => toggleSelected(t.theme_id)}>✕</button>
                    </div>
                  ))}
                </div>
                <Button size="small" variant="contained" onClick={openInMarketWatch}
                  sx={{ fontSize: "0.68rem", backgroundColor: "#8b5cf6", "&:hover": { backgroundColor: "#7c3aed" } }}>
                  Open in Market Watch
                </Button>
                <Button size="small" variant="outlined"
                  onClick={() => markExplored(selectedIds, true)}
                  sx={{ fontSize: "0.68rem", color: "#aeb7c2", borderColor: "#3a3a3a" }}>
                  Mark explored
                </Button>
                <Button size="small" onClick={() => setSelectedIds(new Set())}
                  sx={{ fontSize: "0.68rem", color: "#8f9aa7" }}>
                  Clear selection
                </Button>
              </>
            )}
          </div>

          <div className="rrg-right-section" style={{ flex: 1, minHeight: 0 }}>
            <h3>Explored ({exploredCount})</h3>
            {exploredThemes.length === 0 ? (
              <span style={{ fontSize: "0.7rem", color: "#8f9aa7" }}>None yet.</span>
            ) : (
              <div className="rrg-mini-list" style={{ maxHeight: "none", flex: 1 }}>
                {exploredThemes.map(t => (
                  <div key={t.theme_id} className="rrg-mini-row">
                    <span style={{ flex: 1 }}>{t.theme_name}</span>
                    <button onClick={() => markExplored([t.theme_id], false)} title="Unexplore">↺</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rrg-right-section" style={{ marginTop: "auto" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <h3>Filter</h3>
              <span style={{ fontSize: "0.62rem", color: "#8f9aa7" }}>
                {items.length}/{totalCount}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <FormControlLabel
                control={
                  <Checkbox size="small" checked={exploreFilter === "unexplored"}
                    onChange={(e) => setExploreFilter(e.target.checked ? "unexplored" : "all")}
                    sx={{ padding: "2px", color: "#8f9aa7", "&.Mui-checked": { color: "#58a6ff" } }} />
                }
                label={<span style={{ fontSize: "0.7rem" }}>Hide explored</span>}
                sx={{ margin: 0 }}
              />
              <button
                onClick={() => setExploredIds(new Set())}
                disabled={exploredCount === 0}
                style={{
                  background: "transparent", border: "none",
                  color: exploredCount === 0 ? "#444" : "#8f9aa7",
                  opacity: exploredCount === 0 ? 0.4 : 1,
                  fontSize: "0.62rem", cursor: exploredCount === 0 ? "default" : "pointer",
                  padding: "2px 4px",
                }}
                title="Clear all explored"
              >
                🗑 Clear
              </button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
