import { Menu, MenuItem } from "@mui/material";

export interface ChartMenuPosition {
  left: number;
  top: number;
}

interface ChartContextMenuProps {
  position: ChartMenuPosition | null;
  onClose: () => void;
  onResetView: () => void;
  resetLabel?: string;
  onRefreshCandles?: () => void;
}

export function ChartContextMenu({
  position,
  onClose,
  onResetView,
  resetLabel = "Reset chart view",
  onRefreshCandles,
}: ChartContextMenuProps) {
  return (
    <Menu
      open={position !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={position ?? undefined}
    >
      <MenuItem onClick={onResetView}>{resetLabel}</MenuItem>
      {onRefreshCandles !== undefined && (
        <MenuItem onClick={onRefreshCandles}>Refresh Yahoo candles</MenuItem>
      )}
    </Menu>
  );
}
