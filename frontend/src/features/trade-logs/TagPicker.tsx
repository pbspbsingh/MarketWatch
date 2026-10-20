import { Autocomplete, Chip, TextField } from "@mui/material";
import type { TradeLogTag } from "../../api/tradeLogs";

export function TagPicker({ tags, ids, onChange, label = "Tags", disabled = false }: {
  tags: TradeLogTag[]; ids: number[]; onChange: (ids: number[]) => void; label?: string; disabled?: boolean;
}) {
  const unknown = ids.filter(id => !tags.some(tag => tag.id === id));
  const options = [...tags, ...unknown.map(id => ({ id, name: `Unavailable tag #${id}`, description: null, revision: 0, trade_count: 0, execution_count: 0 }))];
  return <Autocomplete
    multiple size="small" options={options} disabled={disabled}
    value={options.filter(tag => ids.includes(tag.id))}
    isOptionEqualToValue={(a, b) => a.id === b.id}
    getOptionLabel={tag => tag.name}
    onChange={(_, values) => onChange(values.map(tag => tag.id))}
    renderValue={(values, getItemProps) => values.map((tag, index) => {
      const { key, ...props } = getItemProps({ index });
      return <Chip {...props} key={key} size="small" label={tag.name} />;
    })}
    renderInput={params => <TextField {...params} label={label} placeholder={ids.length ? undefined : "Choose tags"} />}
    noOptionsText="Create tags in the Tags tab"
  />;
}
