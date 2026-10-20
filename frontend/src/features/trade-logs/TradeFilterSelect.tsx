import { useId } from "react";
import { Checkbox, FormControl, InputLabel, MenuItem, Select } from "@mui/material";

export function TradeFilterSelect<T extends string | number>({ label, values, options, onChange, className = "" }: {
  label: string; values: T[]; options: { value: T; label: string }[]; onChange: (values: T[]) => void; className?: string;
}) {
  const id = useId();
  return <FormControl size="small" className={`tl-filter-select ${className}`}>
    <InputLabel id={id} shrink>{label}</InputLabel>
    <Select<T[]> multiple labelId={id} label={label} value={values} displayEmpty
      renderValue={selected => <span className={selected.length ? "tl-filter-value" : "tl-filter-placeholder"}>{selected.length ? selected.map(value => options.find(option => option.value === value)?.label ?? String(value)).join(", ") : "Any"}</span>}
      onChange={event => {
        const selected = event.target.value;
        onChange(typeof selected === "string" ? options.filter(option => selected.split(",").includes(String(option.value))).map(option => option.value) : selected);
      }}
      MenuProps={{ slotProps: { paper: { className: "tl-filter-menu" } } }}>
      {options.map(option => <MenuItem key={option.value} value={option.value}>
        <Checkbox size="small" checked={values.includes(option.value)} tabIndex={-1} disableRipple />{option.label}
      </MenuItem>)}
    </Select>
  </FormControl>;
}
