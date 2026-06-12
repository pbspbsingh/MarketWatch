import { createTheme } from "@mui/material/styles";

export const appTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#111418",
      paper: "#191e24",
    },
    primary: {
      main: "#58a6ff",
    },
    text: {
      primary: "#d7dce2",
      secondary: "#8f9aa7",
    },
    divider: "#2a3038",
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
