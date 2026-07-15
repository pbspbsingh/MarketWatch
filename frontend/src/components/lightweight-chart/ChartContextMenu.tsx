import { Menu, MenuItem } from "@mui/material";

export interface ChartMenuPosition {
  left: number;
  top: number;
}

interface ChartContextMenuProps {
  position: ChartMenuPosition | null;
  onClose: () => void;
  onResetView: () => void;
}

export function ChartContextMenu({
  position,
  onClose,
  onResetView,
}: ChartContextMenuProps) {
  return (
    <Menu
      open={position !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={position ?? undefined}
    >
      <MenuItem onClick={onResetView}>Reset chart view</MenuItem>
    </Menu>
  );
}
