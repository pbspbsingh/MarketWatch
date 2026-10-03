import { useId, type ReactNode } from "react";
import CloseIcon from "@mui/icons-material/Close";
import TuneIcon from "@mui/icons-material/Tune";
import {
  Drawer,
  IconButton,
  Slider,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import {
  useAppSettings,
  validCandlePalette,
  validRelativeStrengthLineStyle,
  type CandlePalette,
  type RelativeStrengthLineStyle,
} from "./AppSettings";
import { candleSeriesOptions } from "../components/lightweight-chart/chartOptions";

const lineStyles: Array<{
  value: RelativeStrengthLineStyle;
  label: string;
  dash?: string;
}> = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dash", dash: "3 3" },
  { value: "large-dashed", label: "Long", dash: "8 4" },
  { value: "sparse-dotted", label: "Dots", dash: "1 5" },
];

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    theme, setTheme,
    chartEngine, setChartEngine,
    candlePalette, setCandlePalette,
    gridOpacity, setGridOpacity,
    fiveEmaOpacity, setFiveEmaOpacity,
    relativeStrengthLineStyle, setRelativeStrengthLineStyle,
    showWeeklyChartOverlay, setShowWeeklyChartOverlay,
    showWeeklyOverlayAxes, setShowWeeklyOverlayAxes,
    syncWeeklyOverlayCrosshair, setSyncWeeklyOverlayCrosshair,
  } = useAppSettings();
  const lightweight = chartEngine === "lightweight";
  const engineLabelId = useId();
  const candleLabelId = useId();

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { className: "settings-drawer", "aria-labelledby": "settings-title" } }}
    >
      <header className="settings-drawer-header">
        <span className="settings-header-icon" aria-hidden="true"><TuneIcon /></span>
        <div className="settings-header-copy">
          <h2 id="settings-title">Settings</h2>
          <p>Display &amp; chart preferences</p>
        </div>
        <IconButton size="small" aria-label="Close settings" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </header>
      <div className="settings-drawer-body">
        <SettingsSection title="Appearance">
          <SettingsSwitch
            label="Dark mode"
            checked={theme === "dark"}
            onChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        </SettingsSection>

        <SettingsSection title="Charts">
          <div className="settings-choice-row">
            <span id={engineLabelId} className="settings-control-label">Chart engine</span>
            <ToggleButtonGroup
              className="settings-choice-segments" exclusive size="small"
              value={chartEngine} aria-labelledby={engineLabelId}
              onChange={(_, value) => {
                if (value === "tradingview" || value === "lightweight") setChartEngine(value);
              }}
            >
              <ToggleButton value="tradingview" aria-label="TradingView chart">TradingView</ToggleButton>
              <ToggleButton value="lightweight" aria-label="Lightweight Charts">Lightweight</ToggleButton>
            </ToggleButtonGroup>
          </div>
          {!lightweight && <p className="settings-hint">Choose Lightweight to customize chart styles.</p>}
          <div className="settings-choice-row">
            <span id={candleLabelId} className="settings-control-label">Candle style</span>
            <ToggleButtonGroup
              className="settings-choice-segments settings-candle-styles" disabled={!lightweight} exclusive size="small"
              value={candlePalette} aria-labelledby={candleLabelId}
              onChange={(_, value) => {
                if (validCandlePalette(value)) setCandlePalette(value);
              }}
            >
              <ToggleButton value="solid" aria-label="Red and green candles"><CandleSample /> Solid</ToggleButton>
              <ToggleButton value="hollow" aria-label="Red and hollow green candles"><CandleSample palette="hollow" /> Hollow</ToggleButton>
              <ToggleButton value="monochrome" aria-label="Monochrome candles" title="Monochrome"><CandleSample palette="monochrome" /> Mono</ToggleButton>
            </ToggleButtonGroup>
          </div>
          {candlePalette === "monochrome" && <p className="settings-hint">Up: hollow candles, lighter volume. Down: filled candles, darker volume.</p>}
          <OpacityControl label="Grid opacity" value={gridOpacity} onChange={setGridOpacity} disabled={!lightweight} />
        </SettingsSection>

        <SettingsSection title="Indicators">
          <div className="settings-control">
            <span className="settings-control-label">Relative strength line</span>
            <ToggleButtonGroup
              className="settings-line-styles"
              disabled={!lightweight} exclusive fullWidth size="small"
              value={relativeStrengthLineStyle} aria-label="Relative strength line style"
              onChange={(_, value) => {
                if (validRelativeStrengthLineStyle(value)) setRelativeStrengthLineStyle(value);
              }}
            >
              {lineStyles.map(({ value, label, dash }) => (
                <ToggleButton key={value} value={value} aria-label={`${label} relative strength line`}>
                  <svg viewBox="0 0 36 8" aria-hidden="true">
                    <path d="M1 4H35" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} strokeLinecap="round" />
                  </svg>
                  {label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>
          <OpacityControl label="5 EMA opacity" value={fiveEmaOpacity} onChange={setFiveEmaOpacity} disabled={!lightweight} />
        </SettingsSection>

        <SettingsSection title="Weekly overlay">
          <SettingsSwitch
            label="Show weekly overlay"
            description="A floating chart in Ticker Lens"
            checked={showWeeklyChartOverlay}
            onChange={setShowWeeklyChartOverlay}
          />
          <p className="settings-shortcut"><kbd>Alt / Option</kbd><span>+</span><kbd>W</kbd><span>to toggle</span></p>
          <div className="settings-overlay-options">
            <SettingsSwitch
              label="Price & time axes"
              description="Show price and date labels on the overlay"
              checked={showWeeklyOverlayAxes}
              onChange={setShowWeeklyOverlayAxes}
              disabled={!showWeeklyChartOverlay}
            />
            <SettingsSwitch
              label="Sync crosshair"
              description="Follow the weekly chart’s date and price"
              checked={syncWeeklyOverlayCrosshair}
              onChange={setSyncWeeklyOverlayCrosshair}
              disabled={!showWeeklyChartOverlay || !lightweight}
            />
          </div>
        </SettingsSection>
      </div>
    </Drawer>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id} className="settings-section-title">{title}</h3>
      <div className="settings-section-controls">{children}</div>
    </section>
  );
}

function SettingsSwitch({ label, description, checked, onChange, disabled = false }: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`settings-switch-row${disabled ? " settings-control-disabled" : ""}`}>
      <span className="settings-switch-copy">
        <span className="settings-control-label">{label}</span>
        {description && <span className="settings-description">{description}</span>}
      </span>
      <Switch
        size="small" checked={checked} disabled={disabled}
        onChange={(_, value) => onChange(value)}
        slotProps={{ input: { "aria-label": label } }}
      />
    </label>
  );
}

function OpacityControl({ label, value, onChange, disabled }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const id = useId();
  const percent = Math.round(value * 100);
  return (
    <div className={`settings-control settings-opacity-control${disabled ? " settings-control-disabled" : ""}`}>
      <div className="settings-control-label-row">
        <span id={id} className="settings-control-label">{label}</span>
        <span className="settings-value">{percent}%</span>
      </div>
      <Slider
        disabled={disabled} min={0} max={100} size="small" value={percent}
        aria-labelledby={id} valueLabelDisplay="auto" valueLabelFormat={(next) => `${next}%`}
        onChange={(_, next) => {
          if (typeof next === "number") onChange(next / 100);
        }}
      />
    </div>
  );
}

function CandleSample({ palette = "solid" }: { palette?: CandlePalette }) {
  const { theme } = useAppSettings();
  const options = candleSeriesOptions(palette, theme);
  const up = palette === "monochrome" ? options.borderUpColor : "var(--color-positive)";
  const down = palette === "monochrome" ? options.borderDownColor : "var(--color-negative)";
  return (
    <svg className="settings-candle-sample" viewBox="0 0 24 20" aria-hidden="true">
      <path d="M7 1v18" stroke={up} strokeWidth="1.5" />
      <rect x="3.5" y="5" width="7" height="9" rx="1" stroke={up} strokeWidth="1.5" fill={palette === "solid" ? up : "var(--color-surface)"} />
      <path d="M18 1v18" stroke={down} strokeWidth="1.5" />
      <rect x="14.5" y="7" width="7" height="8" rx="1" fill={down} />
    </svg>
  );
}
