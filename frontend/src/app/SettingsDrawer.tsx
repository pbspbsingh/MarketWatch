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
import { RelativeStrengthSmoothingControl } from "./RelativeStrengthSmoothingControl";
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
    logarithmicScale, setLogarithmicScale,
    showCandleReadout, setShowCandleReadout,
    candlePalette, setCandlePalette,
    gridOpacity, setGridOpacity,
    fiveEmaOpacity, setFiveEmaOpacity,
    relativeStrengthLineStyle, setRelativeStrengthLineStyle,
    showRelativeStrength, setShowRelativeStrength,
    showWeeklyChartOverlay, setShowWeeklyChartOverlay,
    showWeeklyOverlayAxes, setShowWeeklyOverlayAxes,
    showWeeklyOverlayRelativeStrength, setShowWeeklyOverlayRelativeStrength,
    syncWeeklyOverlayCrosshair, setSyncWeeklyOverlayCrosshair,
  } = useAppSettings();
  const scaleLabelId = useId();
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
            <span id={scaleLabelId} className="settings-control-label">Price scale</span>
            <ToggleButtonGroup
              className="settings-choice-segments settings-visual-choices" exclusive size="small"
              value={logarithmicScale ? "logarithmic" : "regular"} aria-labelledby={scaleLabelId}
              onChange={(_, value) => {
                if (value === "regular" || value === "logarithmic") {
                  setLogarithmicScale(value === "logarithmic");
                }
              }}
            >
              <ToggleButton value="regular"><PriceScaleSample /> Regular</ToggleButton>
              <ToggleButton value="logarithmic"><PriceScaleSample logarithmic /> Log</ToggleButton>
            </ToggleButtonGroup>
          </div>
          <div className="settings-choice-row">
            <span id={candleLabelId} className="settings-control-label">Candle style</span>
            <ToggleButtonGroup
              className="settings-choice-segments settings-visual-choices" exclusive size="small"
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
          <OpacityControl label="Grid opacity" value={gridOpacity} onChange={setGridOpacity} />
        </SettingsSection>

        <SettingsSection title="Indicators">
          <SettingsSwitch
            label="Show candle readout"
            checked={showCandleReadout}
            onChange={setShowCandleReadout}
          />
          <OpacityControl label="5 EMA opacity" value={fiveEmaOpacity} onChange={setFiveEmaOpacity} />
        </SettingsSection>

        <SettingsSection title="RS Line">
          <SettingsSwitch
            label="Show RS"
            checked={showRelativeStrength}
            onChange={setShowRelativeStrength}
          />
          <div className="settings-control">
            <span className="settings-control-label">RS Line Style</span>
            <ToggleButtonGroup
              className="settings-line-styles"
              exclusive fullWidth size="small"
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
          <RelativeStrengthSmoothingControl interval="daily" label="Daily smoothing" />
          <RelativeStrengthSmoothingControl interval="weekly" label="Weekly Smoothing" />
        </SettingsSection>

        <SettingsSection title="Weekly overlay">
          <SettingsSwitch
            label="Show weekly overlay"
            checked={showWeeklyChartOverlay}
            onChange={setShowWeeklyChartOverlay}
          />
          <p className="settings-shortcut"><kbd>Alt / Option</kbd><span>+</span><kbd>W</kbd></p>
          <div className="settings-overlay-options">
            <SettingsSwitch
              label="Show RS Line"
              checked={showWeeklyOverlayRelativeStrength}
              onChange={setShowWeeklyOverlayRelativeStrength}
              disabled={!showWeeklyChartOverlay}
            />
            <SettingsSwitch
              label="Price & time axes"
              checked={showWeeklyOverlayAxes}
              onChange={setShowWeeklyOverlayAxes}
              disabled={!showWeeklyChartOverlay}
            />
            <SettingsSwitch
              label="Sync crosshair"
              checked={syncWeeklyOverlayCrosshair}
              onChange={setSyncWeeklyOverlayCrosshair}
              disabled={!showWeeklyChartOverlay}
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

function SettingsSwitch({ label, checked, onChange, disabled = false }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`settings-switch-row${disabled ? " settings-control-disabled" : ""}`}>
      <span className="settings-control-label">{label}</span>
      <Switch
        size="small" checked={checked} disabled={disabled}
        onChange={(_, value) => onChange(value)}
        slotProps={{ input: { "aria-label": label } }}
      />
    </label>
  );
}

function OpacityControl({ label, value, onChange, disabled = false }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
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

function PriceScaleSample({ logarithmic = false }: { logarithmic?: boolean }) {
  return (
    <svg className="settings-scale-sample" viewBox="0 0 24 20" aria-hidden="true">
      <path d="M3 2v15h19" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <path
        d={logarithmic ? "M6 14C8 6 13 4 21 3" : "M6 14L21 3"}
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
    </svg>
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
