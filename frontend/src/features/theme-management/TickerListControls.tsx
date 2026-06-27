import { type Dispatch, type SetStateAction, useState } from "react";
import { Button, Checkbox, Menu, MenuItem } from "@mui/material";

export function TickerFilters({
  unprocessedOnly,
  setUnprocessedOnly,
  unassignedOnly,
  setUnassignedOnly,
}: {
  unprocessedOnly: boolean;
  setUnprocessedOnly: Dispatch<SetStateAction<boolean>>;
  unassignedOnly: boolean;
  setUnassignedOnly: Dispatch<SetStateAction<boolean>>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const activeCount = Number(unprocessedOnly) + Number(unassignedOnly);

  return (
    <div className="ticker-selection-controls">
      <Button size="small" onClick={(event) => setAnchor(event.currentTarget)}>
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => setUnprocessedOnly((current) => !current)}>
          <Checkbox size="small" checked={unprocessedOnly} />
          Unprocessed
        </MenuItem>
        <MenuItem onClick={() => setUnassignedOnly((current) => !current)}>
          <Checkbox size="small" checked={unassignedOnly} />
          Unassigned
        </MenuItem>
      </Menu>
    </div>
  );
}

export function TickerSelectionHeader({
  selectedCount,
  visibleCount,
  onChange,
}: {
  selectedCount: number;
  visibleCount: number;
  onChange: (selectAll: boolean) => void;
}) {
  const allSelected = visibleCount > 0 && selectedCount === visibleCount;

  return (
    <div className="ticker-selection-header">
      <Checkbox
        size="small"
        checked={allSelected}
        indeterminate={selectedCount > 0 && !allSelected}
        disabled={visibleCount === 0}
        inputProps={{
          "aria-label": allSelected ? "Select no visible tickers" : "Select all visible tickers",
        }}
        onChange={() => onChange(!allSelected)}
      />
      <span>
        {selectedCount} of {visibleCount} selected
      </span>
    </div>
  );
}
