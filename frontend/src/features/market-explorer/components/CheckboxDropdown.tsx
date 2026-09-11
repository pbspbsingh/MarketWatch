import { Fragment, useState } from "react";
import { Button, Checkbox, ListSubheader, Menu, MenuItem, TextField } from "@mui/material";
import "./market-explorer-controls.css";

export function CheckboxDropdown<Value extends string | number>({
  label,
  options,
  selectedValues,
  onCommit,
}: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: string; group?: string }>;
  selectedValues: ReadonlySet<Value>;
  onCommit: (values: Set<Value>) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const [draftValues, setDraftValues] = useState<Set<Value>>();
  const displayedValues = draftValues ?? selectedValues;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredOptions = normalizedSearch === ""
    ? options
    : options.filter((option) => option.label.toLowerCase().includes(normalizedSearch));
  const allSelected = displayedValues.size === options.length;

  const toggle = (value: Value) => {
    const next = new Set(displayedValues);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setDraftValues(next);
  };
  const close = (commit: boolean) => {
    if (commit && draftValues !== undefined && !setsEqual(draftValues, selectedValues)) {
      onCommit(draftValues);
    }
    setAnchor(null);
    setSearch("");
    setDraftValues(undefined);
  };

  return (
    <>
      <Button
        className="market-explorer-checkbox-dropdown"
        size="small"
        disabled={options.length === 0}
        onClick={(event) => {
          setDraftValues(new Set(selectedValues));
          setAnchor(event.currentTarget);
        }}
      >
        {label}: {allSelected ? "All" : `${displayedValues.size}/${options.length}`}
      </Button>
      <Menu
        className="market-explorer-checkbox-menu"
        anchorEl={anchor}
        open={anchor !== null}
        disableAutoFocusItem
        onClose={(_, reason) => close(reason !== "escapeKeyDown")}
      >
        <ListSubheader className="market-explorer-checkbox-menu-header">
          <TextField
            autoFocus
            size="small"
            placeholder={`Search ${label.toLowerCase()}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <div className="market-explorer-checkbox-menu-actions">
            <Button
              size="small"
              disabled={allSelected}
              onClick={() => setDraftValues(new Set(options.map((option) => option.value)))}
            >
              Check all
            </Button>
            <Button
              size="small"
              disabled={displayedValues.size === 0}
              onClick={() => setDraftValues(new Set())}
            >
              Uncheck all
            </Button>
          </div>
        </ListSubheader>
        {filteredOptions.map((option, index) => (
          <Fragment key={option.value}>
            {option.group !== undefined && option.group !== filteredOptions[index - 1]?.group && (
              <ListSubheader className="market-explorer-checkbox-menu-group" disableSticky>
                {option.group}
              </ListSubheader>
            )}
            <MenuItem onClick={() => toggle(option.value)}>
              <Checkbox size="small" checked={displayedValues.has(option.value)} />
              {option.label}
            </MenuItem>
          </Fragment>
        ))}
      </Menu>
    </>
  );
}

function setsEqual<Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
