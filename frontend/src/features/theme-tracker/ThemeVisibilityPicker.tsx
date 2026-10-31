import { useMemo, useState } from "react";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { Badge, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItemButton, ListItemText, TextField, Tooltip, Typography } from "@mui/material";
import type { TrackerRow } from "../../api/generated/contracts";

export function ThemeVisibilityPicker({ rows, hiddenKeys, onVisibilityChange }: {
  rows: TrackerRow[];
  hiddenKeys: ReadonlySet<string>;
  onVisibilityChange: (keys: string[], visible: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const alphabetical = useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);
  const filtered = alphabetical.filter(row => `${row.name} ${row.etf_symbol}`.toLowerCase().includes(search.trim().toLowerCase()));
  const hiddenCount = rows.filter(row => hiddenKeys.has(row.key)).length;
  return <>
    <Tooltip title="Choose visible themes">
      <span><IconButton size="small" aria-label="Choose visible themes" disabled={rows.length === 0} onClick={() => { setSearch(""); setOpen(true); }}>
        <Badge badgeContent={hiddenCount} color="primary"><VisibilityOutlinedIcon fontSize="small" /></Badge>
      </IconButton></span>
    </Tooltip>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Visible themes</DialogTitle>
      <DialogContent dividers>
        <TextField autoFocus fullWidth size="small" label="Search themes" value={search} onChange={event => setSearch(event.target.value)} />
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1 }}>
          <Typography variant="caption" sx={{ flex: 1 }}>{rows.length - hiddenCount} of {rows.length} visible</Typography>
          <Button size="small" onClick={() => onVisibilityChange(rows.map(row => row.key), true)}>Show all</Button>
          <Button size="small" onClick={() => onVisibilityChange(rows.map(row => row.key), false)}>Hide all</Button>
        </Box>
        <List dense sx={{ height: "min(24rem, 45vh)", overflow: "auto" }}>
          {filtered.map(row => <ListItemButton key={row.key} role="checkbox" aria-checked={!hiddenKeys.has(row.key)}
            onClick={() => onVisibilityChange([row.key], hiddenKeys.has(row.key))}>
            <Checkbox checked={!hiddenKeys.has(row.key)} tabIndex={-1} disableRipple sx={{ pointerEvents: "none" }} slotProps={{ input: { "aria-hidden": true } }} />
            <ListItemText primary={row.name} secondary={row.etf_symbol} />
          </ListItemButton>)}
          {filtered.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No matching themes</Typography>}
        </List>
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Done</Button></DialogActions>
    </Dialog>
  </>;
}
