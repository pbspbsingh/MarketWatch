import { createTheme } from "@mui/material/styles";

export type AppThemeMode = "dark" | "light";
export type FeatureAccent =
  | "purple"
  | "yellow"
  | "green"
  | "coral"
  | "magenta"
  | "amber"
  | "lime"
  | "blue";

export type AppPalette = {
  canvas: string;
  surface: string;
  raised: string;
  hover: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  positive: string;
  negative: string;
  warning: string;
  overlay: string;
};

export const appPalettes: Record<AppThemeMode, AppPalette> = {
  dark: {
    canvas: "#111418",
    surface: "#191e24",
    raised: "#20262e",
    hover: "#253140",
    border: "#343b45",
    text: "#f0f4f8",
    muted: "#8f9aa7",
    accent: "#58a6ff",
    positive: "#2fbf71",
    negative: "#ef5350",
    warning: "#f2c94c",
    overlay: "rgb(0 0 0 / 55%)",
  },
  light: {
    canvas: "#f4f6f8",
    surface: "#ffffff",
    raised: "#eef1f4",
    hover: "#e3e8ee",
    border: "#c4ccd6",
    text: "#17202a",
    muted: "#5f6b78",
    accent: "#1769aa",
    positive: "#137a55",
    negative: "#c23847",
    warning: "#986500",
    overlay: "rgb(20 27 35 / 35%)",
  },
};

export const featureAccents: Record<AppThemeMode, Record<FeatureAccent, string>> = {
  dark: {
    purple: "#8b5cf6",
    yellow: "#f2c94c",
    green: "#2fbf71",
    coral: "#fb7185",
    magenta: "#e879f9",
    amber: "#f59e0b",
    lime: "#84cc16",
    blue: "#58a6ff",
  },
  light: {
    purple: "#6d3fd1",
    yellow: "#8a6500",
    green: "#137a55",
    coral: "#c2415a",
    magenta: "#9836a3",
    amber: "#9a5b00",
    lime: "#527d0b",
    blue: "#1769aa",
  },
};

const cssVariables: Record<keyof AppPalette, string> = {
  canvas: "--color-canvas",
  surface: "--color-surface",
  raised: "--color-raised",
  hover: "--color-hover",
  border: "--color-border",
  text: "--color-text",
  muted: "--color-muted",
  accent: "--color-accent",
  positive: "--color-positive",
  negative: "--color-negative",
  warning: "--color-warning",
  overlay: "--color-overlay",
};

export function applyThemeToDocument(mode: AppThemeMode) {
  const root = document.documentElement;
  const palette = appPalettes[mode];
  const accents = featureAccents[mode];
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  for (const [name, variable] of Object.entries(cssVariables)) {
    root.style.setProperty(variable, palette[name as keyof AppPalette]);
  }
  for (const [name, color] of Object.entries(accents)) {
    root.style.setProperty(`--accent-${name}`, color);
  }
}

export function createAppTheme(mode: AppThemeMode) {
  const palette = appPalettes[mode];
  return createTheme({
    palette: {
      mode,
      background: {
        default: palette.canvas,
        paper: palette.surface,
      },
      primary: {
        main: palette.accent,
      },
      success: {
        main: palette.positive,
      },
      error: {
        main: palette.negative,
      },
      warning: {
        main: palette.warning,
      },
      text: {
        primary: palette.text,
        secondary: palette.muted,
      },
      divider: palette.border,
      action: {
        hover: palette.hover,
        selected: palette.hover,
      },
    },
    shape: {
      borderRadius: 4,
    },
    spacing: 8,
    typography: {
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontSize: 12,
    },
    components: {
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
      },
      MuiCssBaseline: {
        styleOverrides: {
          "html, body, #root": {
            width: "100%",
            height: "100%",
          },
          body: {
            margin: 0,
            overflow: "hidden",
          },
        },
      },
      MuiTooltip: {
        defaultProps: {
          enterDelay: 500,
        },
      },
    },
  });
}
