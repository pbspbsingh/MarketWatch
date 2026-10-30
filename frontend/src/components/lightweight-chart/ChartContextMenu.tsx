import { Menu, MenuItem } from "@mui/material";

export interface ChartMenuPosition {
  left: number;
  top: number;
}

export function ChartContextMenu({ position, onClose, onResetZoom, onClearPriceCache, clearing }: {
  position: ChartMenuPosition | null;
  onClose: () => void;
  onResetZoom: () => void;
  onClearPriceCache: () => void;
  clearing: boolean;
}) {
  return (
    <Menu open={position !== null} onClose={onClose} anchorReference="anchorPosition" anchorPosition={position ?? undefined}>
      <MenuItem onClick={onResetZoom}>Reset chart zoom</MenuItem>
      <MenuItem onClick={onClearPriceCache} disabled={clearing}>Clear price cache</MenuItem>
    </Menu>
  );
}
