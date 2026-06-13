import { Alert, Snackbar, type AlertColor } from "@mui/material";

interface ToastProps {
  message?: string;
  severity?: AlertColor;
  onClose: () => void;
}

export function Toast({ message, severity = "error", onClose }: ToastProps) {
  return (
    <Snackbar
      open={message !== undefined}
      autoHideDuration={6000}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
    >
      <Alert severity={severity} variant="filled" onClose={onClose}>
        {message}
      </Alert>
    </Snackbar>
  );
}

