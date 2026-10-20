import { useId, useState } from "react";
import { Button, InputAdornment, Popover, TextField, useMediaQuery } from "@mui/material";
import CalendarTodayOutlinedIcon from "@mui/icons-material/CalendarTodayOutlined";
import { DayPicker, type DateRange } from "@daypicker/react";
import "@daypicker/react/style.css";
import "./date-range-picker.css";

const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const fromKey = (value: string) => value ? new Date(`${value}T00:00:00`) : undefined;
// Calendar dates stay local: converting to UTC can shift the selected day.
const toKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function rangeLabel(from?: Date, to?: Date) {
  if (from && to) return dateLabel.formatRange(from, to);
  if (from) return `${dateLabel.format(from)} – Select end date`;
  if (to) return `Through ${dateLabel.format(to)}`;
  return "All dates";
}

export function DateRangePicker({ start, end, onChange }: {
  start: string; end: string; onChange: (start: string, end: string) => void;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState<DateRange>();
  const twoMonths = useMediaQuery("(min-width: 600px)");
  const open = (element: HTMLElement) => {
    setDraft(start || end ? { from: fromKey(start), to: fromKey(end) } : undefined);
    setAnchor(element);
  };
  const apply = () => {
    if (!draft?.from || !draft.to) return;
    onChange(toKey(draft.from), toKey(draft.to));
    setAnchor(null);
  };
  return <>
    <TextField size="small" label="Date range" className="date-range-picker" value={rangeLabel(fromKey(start), fromKey(end))}
      onClick={event => open(event.currentTarget)}
      onKeyDown={event => { if (["Enter", " ", "ArrowDown"].includes(event.key)) { event.preventDefault(); open(event.currentTarget); } }}
      slotProps={{
        htmlInput: { readOnly: true, "aria-haspopup": "dialog", "aria-expanded": anchor !== null, "aria-controls": anchor ? id : undefined },
        input: { endAdornment: <InputAdornment position="end"><CalendarTodayOutlinedIcon fontSize="small" /></InputAdornment> },
      }} />
    <Popover open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{ paper: { id, className: "date-range-popover", role: "dialog", "aria-label": "Choose date range" } }}>
      <p className="date-range-selection" aria-live="polite">{draft ? rangeLabel(draft.from, draft.to) : "Select start and end dates"}</p>
      <DayPicker mode="range" autoFocus numberOfMonths={twoMonths ? 2 : 1} captionLayout="dropdown" navLayout="after"
        defaultMonth={draft?.from ?? draft?.to} startMonth={new Date(1970, 0)} endMonth={new Date(new Date().getFullYear() + 10, 11)}
        selected={draft} onSelect={(range, day) => setDraft(draft?.from && !draft.to ? range : { from: day })} />
      <div className="date-range-actions">
        <Button size="small" onClick={() => { onChange("", ""); setAnchor(null); }}>Clear</Button>
        <Button size="small" onClick={() => setAnchor(null)}>Cancel</Button>
        <Button size="small" variant="contained" disabled={!draft?.from || !draft.to} onClick={apply}>Apply</Button>
      </div>
    </Popover>
  </>;
}
