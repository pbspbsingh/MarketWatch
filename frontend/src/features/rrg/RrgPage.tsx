import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  IconButton,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
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
      <header className="theme-management-header">
        <Typography component="h1">Relative Rotation Graph</Typography>
        <div className="rrg-controls">
          <ToggleButtonGroup value={interval} exclusive size="small" onChange={(_, v) => v && setInterval(v)}>
            <ToggleButton value="daily">Daily</ToggleButton>
            <ToggleButton value="weekly">Weekly</ToggleButton>
          </ToggleButtonGroup>
          <div className="rrg-slider-control rrg-slider-control-wide">
            <Typography variant="caption">
              Lookback: {lookback}
            </Typography>
            <Slider min={lookbackMin} max={lookbackMax} value={lookback} onChange={(_, v) => setLookback(v as number)} size="small" />
          </div>
          <div className="rrg-slider-control">
            <Typography variant="caption">
              Tail: {tail}
            </Typography>
            <Slider min={1} max={50} value={tail} onChange={(_, v) => setTail(v as number)} size="small" />
          </div>
          <div className="rrg-slider-control rrg-slider-control-rs">
            <Typography variant="caption">
              RS ≥ {minRs === null ? "—" : minRs.toFixed(1)}
            </Typography>
            <Slider
              min={rsSliderMin} max={rsSliderMax} step={0.5}
              value={minRs ?? rsSliderMin}
              onChange={(_, v) => setMinRs(v as number)}
              size="small"
            />
          </div>
          <FormControlLabel
            className="rrg-normalize-control"
            control={
              <Checkbox
                size="small"
                checked={normalize}
                onChange={(e) => setNormalize(e.target.checked)}
              />
            }
            label="Normalize"
          />
          <div className="rrg-quadrant-controls">
            {(["leading", "improving", "lagging", "weakening"] as Quadrant[]).map((q) => {
              const active = quadrants[q];
              return (
                <ToggleButton
                  key={q}
                  className="rrg-quadrant-toggle"
                  value={q}
                  selected={active}
                  onClick={() => setQuadrants({ ...quadrants, [q]: !active })}
                >
                  <span
                    className="rrg-quadrant-dot"
                    style={{ background: QUADRANTS[q].dot }}
                  />
                  {q.charAt(0).toUpperCase() + q.slice(1)}
                </ToggleButton>
              );
            })}
            <IconButton
              className="rrg-reset-button"
              size="small"
              onClick={() => { setMinRs(null); setSelectedId(null); }}
              aria-label="Reset RRG filters"
              title="Reset filters"
            >
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </div>
        </div>
      </header>

      <div className="theme-management-body rrg-body">
        <aside className="theme-list-pane">
          <div className="theme-pane-header">
            <Typography component="h2">Themes ({items.length}/{series.length})</Typography>
            <Button
              size="small"
              variant="text"
              onClick={toggleAll}
            >
              {allVisible ? "None" : "All"}
            </Button>
          </div>
          <div className="rrg-theme-list">
            {series.map((s) => (
              <FormControlLabel
                key={s.theme_id}
                className="rrg-theme-row"
                control={
                  <Checkbox
                    size="small"
                    checked={visible[s.theme_id] !== false}
                    onChange={(e) => setVisible({ ...visible, [s.theme_id]: e.target.checked })}
                  />
                }
                label={
                  <span className="rrg-theme-label">
                    {s.theme_name} <span>· {s.etf_symbol}</span>
                  </span>
                }
              />
            ))}
          </div>
        </aside>

        <main className="rrg-main">
          <div className="rrg-canvas-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} />
            <div id="rrg-tooltip" ref={tooltipRef} />
            {loading && (
              <div className="rrg-overlay">
                <CircularProgress size="1rem" />
                <Typography color="text.secondary">Loading RRG</Typography>
              </div>
            )}
            {error && (
              <div className="rrg-error">
                <Typography color="error">{error}</Typography>
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  );
}
