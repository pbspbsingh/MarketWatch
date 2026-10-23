import { useState, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "@mui/material";

/** Help stays above controls and never participates in their pointer interaction. */
export function ControlTooltip({ title, children, disabled = false }: { title: ReactNode; children: ReactElement; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const dismiss = () => { setOpen(false); setDismissed(true); };
  const reset = () => { setOpen(false); setDismissed(false); };
  // A node title also avoids a second, browser-native tooltip below the control.
  return <Tooltip title={disabled || !title ? "" : <span>{title}</span>} describeChild placement="top" disableInteractive disableTouchListener
    enterDelay={500} enterNextDelay={500} leaveDelay={0}
    disableHoverListener={disabled} disableFocusListener={disabled}
    open={open && !dismissed && !disabled} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
    onPointerDownCapture={dismiss} onMouseDownCapture={dismiss} onClickCapture={dismiss} onKeyDownCapture={dismiss}
    onMouseLeave={reset} onBlurCapture={reset}
    slotProps={{ popper: { modifiers: [{ name: "flip", enabled: false }] }, transition: { timeout: { enter: 120, exit: 0 } } }}>
    {children}
  </Tooltip>;
}
