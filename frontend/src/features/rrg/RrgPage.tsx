import { useEffect, useMemo, useRef, useState } from "react";
import {
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { fetchThemeRrg, type ThemeRrgSeries, type RrgPoint } from "../../api/themes";

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

const colorFor = (id: number) => {
  const hues = [210, 120, 30, 280, 170, 0, 260, 80, 340, 190, 45, 300];
  return `hsl(${hues[id % hues.length]}, 70%, 55%)`;
};

type RrgItem = ThemeRrgSeries & { quadrant: Quadrant; rsRatio: number; rsMomentum: number };

function computeViewport(items: RrgItem[]) {
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
  return { xMin, xMax, yMin, yMax };
}

function getPlotTransform(
  W: number, H: number,
  xMin: number, xMax: number, yMin: number, yMax: number
) {
  const M = { top: 36, right: 36, bottom: 44, left: 52 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const toX = (v: number) => M.left + ((v - xMin) / (xMax - xMin)) * plotW;
  const toY = (v: number) => M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  return { M, plotW, plotH, toX, toY };
}

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
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Refs to avoid rebinding hit-test handlers on hover/selection change
  const hoverIdxRef = useRef<number | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  useEffect(() => { hoverIdxRef.current = hoverIdx; }, [hoverIdx]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

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

  // Debounced fetch with AbortController
  const [debouncedLookback, setDebouncedLookback] = useState(lookback);
  const [debouncedTail, setDebouncedTail] = useState(tail);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedLookback(lookback), 250);
    return () => clearTimeout(t);
  }, [lookback]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTail(tail), 250);
    return () => clearTimeout(t);
  }, [tail]);

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
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setError(String(e));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [interval, debouncedLookback, debouncedTail, normalize]);

  const items: RrgItem[] = useMemo(() => {
    return series
      .filter((s) => visible[s.theme_id] !== false && s.points.length > 0)
      .map((s) => {
        const last = s.points[s.points.length - 1];
        return { ...s, quadrant: getQuadrant(last.rs_ratio, last.rs_momentum), rsRatio: last.rs_ratio, rsMomentum: last.rs_momentum };
      })
      .filter((s) => quadrants[s.quadrant])
      .filter((s) => minRs === null || s.rsRatio >= minRs);
  }, [series, visible, quadrants, minRs]);

  // RS slider range
  const rsValues = useMemo(() => items.map(i => i.rsRatio), [items]);
  const rsMin = rsValues.length ? Math.floor(Math.min(...rsValues) * 2) / 2 : 80;
  const rsMax = rsValues.length ? Math.ceil(Math.max(...rsValues) * 2) / 2 : 120;
  const rsSliderMin = Math.min(80, rsMin);
  const rsSliderMax = Math.max(120, rsMax);

  useEffect(() => {
    if (minRs !== null) {
      if (minRs < rsSliderMin || minRs > rsSliderMax) setMinRs(null);
    }
  }, [rsSliderMin, rsSliderMax, minRs]);

  // Viewport helper (shared between draw and hit-test)
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

  // Draw RRG
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

    // BG
    ctx.fillStyle = "#111418";
    ctx.fillRect(0, 0, W, H);

    // Quadrants
    const qFills = [
      { x: cx, y: M.top, w: M.left + plotW - cx, h: cy - M.top, q: QUADRANTS.leading },
      { x: M.left, y: M.top, w: cx - M.left, h: cy - M.top, q: QUADRANTS.improving },
      { x: M.left, y: cy, w: cx - M.left, h: M.top + plotH - cy, q: QUADRANTS.lagging },
      { x: cx, y: cy, w: M.left + plotW - cx, h: M.top + plotH - cy, q: QUADRANTS.weakening },
    ];
    qFills.forEach(({ x, y, w, h, q }) => { ctx.fillStyle = q.color; ctx.fillRect(x, y, w, h); });

    // Grid
    const span = Math.max(xMax - xMin, yMax - yMin);
    const gridStep = span > 30 ? 5 : span > 15 ? 2 : span > 6 ? 1 : 0.5;
    ctx.strokeStyle = "#2a3038";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = Math.ceil(xMin / gridStep) * gridStep; v <= xMax; v += gridStep) {
      const px = toX(v); ctx.moveTo(px, M.top); ctx.lineTo(px, M.top + plotH);
    }
    for (let v = Math.ceil(yMin / gridStep) * gridStep; v <= yMax; v += gridStep) {
      const py = toY(v); ctx.moveTo(M.left, py); ctx.lineTo(M.left + plotW, py);
    }
    ctx.stroke();

    // Axes at 100
    ctx.strokeStyle = "#4a5563";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, M.top); ctx.lineTo(cx, M.top + plotH);
    ctx.moveTo(M.left, cy); ctx.lineTo(M.left + plotW, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Quadrant labels
    ctx.font = "600 10px -apple-system, sans-serif";
    const qLabels = [
      { text: "LEADING",    x: M.left + plotW - 8, y: M.top + 8,          align: "right" as const, color: QUADRANTS.leading.text,    baseline: "top" as const },
      { text: "IMPROVING",  x: M.left + 8,         y: M.top + 8,          align: "left" as const,  color: QUADRANTS.improving.text,  baseline: "top" as const },
      { text: "LAGGING",    x: M.left + 8,         y: M.top + plotH - 8,  align: "left" as const,  color: QUADRANTS.lagging.text,    baseline: "bottom" as const },
      { text: "WEAKENING",  x: M.left + plotW - 8, y: M.top + plotH - 8,  align: "right" as const, color: QUADRANTS.weakening.text,  baseline: "bottom" as const },
    ];
    qLabels.forEach(({ text, x, y, align, color, baseline }) => {
      ctx.textAlign = align; ctx.textBaseline = baseline; ctx.fillStyle = color; ctx.globalAlpha = 0.5;
      ctx.fillText(text, Math.round(x), Math.round(y)); ctx.globalAlpha = 1;
    });

    // Axis ticks
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
    // Axis titles
    ctx.fillStyle = "#8f9aa7"; ctx.font = "11px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("RS-Ratio →", Math.round(M.left + plotW / 2), Math.round(H - 2));
    ctx.save(); ctx.translate(Math.round(12), Math.round(M.top + plotH / 2)); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("RS-Momentum →", 0, 0); ctx.restore();

    // Benchmark marker
    ctx.beginPath(); ctx.arc(Math.round(cx), Math.round(cy), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#444"; ctx.fill();
    ctx.fillStyle = "#8f9aa7"; ctx.font = "10px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("Benchmark", Math.round(cx + 7), Math.round(cy));

    if (!items.length) {
      ctx.fillStyle = "#444"; ctx.font = "14px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(loading ? "Loading…" : "No data", W / 2, H / 2);
      return;
    }

    // Draw tails
    items.forEach((d, idx) => {
      const isHovered = idx === hoverIdx;
      const q = QUADRANTS[d.quadrant];
      const pts = [...d.points.map(p => ({ x: toX(p.rs_ratio), y: toY(p.rs_momentum) }))];
      if (pts.length < 2) return;
      for (let i = 1; i < pts.length; i++) {
        const t = i / pts.length;
        const alpha = t * (isHovered ? 0.85 : 0.5);
        const lw = 1 + t * (isHovered ? 2.5 : 1.5);
        ctx.beginPath();
        ctx.strokeStyle = q.dot;
        ctx.lineWidth = lw;
        ctx.globalAlpha = alpha;
        ctx.lineCap = "round";
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    // Draw dots + labels
    items.forEach((d, idx) => {
      const isHovered = idx === hoverIdx;
      const isSelected = selectedId === d.theme_id;
      const q = QUADRANTS[d.quadrant];
      const x = toX(d.rsRatio), y = toY(d.rsMomentum);
      const r = isHovered || isSelected ? 5 : 3.5;
      if (isHovered || isSelected) {
        ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = q.dot; ctx.globalAlpha = 0.15; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = q.dot; ctx.fill();
      ctx.fillStyle = isHovered || isSelected ? "#fff" : "#aeb7c2";
      ctx.font = `${isHovered || isSelected ? "600 " : ""}10px -apple-system, sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(d.etf_symbol, Math.round(x + r + 3), Math.round(y));
    });
  }, [items, hoverIdx, selectedId, loading]);

  // Hit test / hover – uses refs to avoid rebinding
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
        setSelectedId((prev) => (prev === id ? null : id));
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

  const allVisible = series.every((s) => visible[s.theme_id] !== false);
  const toggleAll = () => {
    const nextVal = !allVisible;
    const next: Record<number, boolean> = {};
    for (const s of series) next[s.theme_id] = nextVal;
    setVisible(next);
  };

  return (
    <section className="theme-management-page">
      <style>{`
        #rrg-tooltip {
          position: absolute; pointer-events: none;
          background: rgba(20,20,20,0.92); border: 1px solid #3a3a3a;
          border-radius: 6px; padding: 8px 12px; font-size: 12px;
          color: #e0e0e0; display: none; white-space: nowrap; z-index: 10; line-height: 1.7;
        }
        #rrg-tooltip .tt-name { font-weight: 700; color: #fff; font-size: 13px; }
        #rrg-tooltip .tt-etf  { font-size: 10px; color: #666; }
        #rrg-tooltip .tt-quad { font-size: 11px; margin-top: 2px; }
        #rrg-tooltip .tt-row  { display: flex; justify-content: space-between; gap: 16px; }
        #rrg-tooltip .tt-val  { color: #4a9eff; font-weight: 600; }
        .rrg-canvas-wrap { flex: 1; min-height: 0; position: relative; overflow: hidden; }
        .rrg-canvas-wrap canvas { display: block; width: 100%; height: 100%; }
      `}</style>
      <header className="theme-management-header">
        <Typography component="h1">Relative Rotation Graph</Typography>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginLeft: "auto", flexWrap: "wrap" }}>
          <ToggleButtonGroup value={interval} exclusive size="small" onChange={(_, v) => v && setInterval(v)}>
            <ToggleButton value="daily" style={{ fontSize: "0.65rem", padding: "0.2rem 0.6rem" }}>Daily</ToggleButton>
            <ToggleButton value="weekly" style={{ fontSize: "0.65rem", padding: "0.2rem 0.6rem" }}>Weekly</ToggleButton>
          </ToggleButtonGroup>
          <div style={{ width: 120 }}>
            <Typography variant="caption" sx={{ fontSize: "0.6rem", textTransform: "uppercase", color: "#8f9aa7" }}>
              Lookback: {lookback}
            </Typography>
            <Slider min={lookbackMin} max={lookbackMax} value={lookback} onChange={(_, v) => setLookback(v as number)} size="small" sx={{ padding: "6px 0" }} />
          </div>
          <div style={{ width: 100 }}>
            <Typography variant="caption" sx={{ fontSize: "0.6rem", textTransform: "uppercase", color: "#8f9aa7" }}>
              Tail: {tail}
            </Typography>
            <Slider min={1} max={50} value={tail} onChange={(_, v) => setTail(v as number)} size="small" sx={{ padding: "6px 0" }} />
          </div>
          <div style={{ width: 110 }}>
            <Typography variant="caption" sx={{ fontSize: "0.6rem", textTransform: "uppercase", color: "#8f9aa7" }}>
              RS ≥ {minRs === null ? "—" : minRs.toFixed(1)}
            </Typography>
            <Slider
              min={rsSliderMin} max={rsSliderMax} step={0.5}
              value={minRs ?? rsSliderMin}
              onChange={(_, v) => setMinRs(v as number)}
              size="small" sx={{ padding: "6px 0" }}
            />
          </div>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={normalize}
                onChange={(e) => setNormalize(e.target.checked)}
                sx={{ padding: "2px", color: "#8f9aa7", "&.Mui-checked": { color: "#58a6ff" } }}
              />
            }
            label={<span style={{ fontSize: "0.65rem", color: "#aeb7c2" }}>Normalize</span>}
            sx={{ margin: 0, marginRight: 1 }}
          />
          <div style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
            {(["leading", "improving", "lagging", "weakening"] as Quadrant[]).map((q) => {
              const active = quadrants[q];
              return (
                <button
                  key={q}
                  onClick={() => setQuadrants({ ...quadrants, [q]: !active })}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "4px",
                    padding: "3px 7px", border: "1px solid #333", borderRadius: "4px",
                    background: "#1a1a1a", color: active ? "#ccc" : "#777",
                    fontSize: "11px", fontWeight: 600, cursor: "pointer",
                    opacity: active ? 1 : 0.35,
                    textDecoration: active ? "none" : "line-through",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: QUADRANTS[q].dot, flexShrink: 0 }} />
                  {q.charAt(0).toUpperCase() + q.slice(1)}
                </button>
              );
            })}
            <button
              onClick={() => { setMinRs(null); setSelectedId(null); }}
              style={{
                padding: "3px 8px", border: "1px solid #3a3a3a", background: "transparent",
                color: "#666", fontSize: "11px", cursor: "pointer", borderRadius: "3px",
              }}
              title="Reset filters"
            >↺</button>
          </div>
        </div>
      </header>

      <div className="theme-management-body" style={{ gridTemplateColumns: "20rem minmax(0, 1fr)" }}>
        <aside className="theme-list-pane">
          <div className="theme-pane-header">
            <Typography component="h2">Themes ({items.length}/{series.length})</Typography>
            <button
              onClick={toggleAll}
              style={{ background: "transparent", border: "none", color: "#58a6ff", cursor: "pointer", fontSize: "0.65rem" }}
            >
              {allVisible ? "None" : "All"}
            </button>
          </div>
          <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
            {series.map((s) => (
              <FormControlLabel
                key={s.theme_id}
                control={
                  <Checkbox
                    size="small"
                    checked={visible[s.theme_id] !== false}
                    onChange={(e) => setVisible({ ...visible, [s.theme_id]: e.target.checked })}
                  />
                }
                label={
                  <span style={{ fontSize: "0.72rem" }}>
                    {s.theme_name} <span style={{ color: "#8f9aa7", fontSize: "0.625rem" }}>· {s.etf_symbol}</span>
                  </span>
                }
                sx={{ display: "flex", margin: 0, padding: "0.15rem 0" }}
              />
            ))}
          </div>
        </aside>

        <main style={{ padding: "0.75rem", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          <div className="rrg-canvas-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} />
            <div id="rrg-tooltip" ref={tooltipRef} />
            {loading && (
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: "0.5rem", background: "rgba(17,20,24,0.7)", zIndex: 5,
              }}>
                <CircularProgress size="1rem" />
                <Typography color="text.secondary" sx={{ fontSize: "0.75rem" }}>Loading RRG</Typography>
              </div>
            )}
            {error && (
              <div style={{
                position: "absolute", top: "0.5rem", left: "0.5rem", right: "0.5rem",
                zIndex: 5,
              }}>
                <Typography color="error" sx={{ fontSize: "0.75rem" }}>{error}</Typography>
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  );
}