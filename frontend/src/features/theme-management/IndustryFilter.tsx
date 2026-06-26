import { type Dispatch, type SetStateAction, useState } from "react";
import { Button, Checkbox, ListSubheader, Menu, MenuItem, TextField } from "@mui/material";
import { type IndustryFilterOption } from "./themeManagementUtils";

export function IndustryFilter({
  industries,
  selectedIndustryKeys,
  setSelectedIndustryKeys,
}: {
  industries: IndustryFilterOption[];
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string> | undefined>>;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const allSelected = selectedIndustryKeys.size === industries.length;
  const filteredIndustries = industries.filter((industry) =>
    industry.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggleIndustry = (key: string) => {
    setSelectedIndustryKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <Button size="small" disabled={industries.length === 0} onClick={(event) => setAnchor(event.currentTarget)}>
        Industries ({selectedIndustryKeys.size}/{industries.length})
      </Button>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        disableAutoFocusItem
        onClose={() => {
          setAnchor(null);
          setSearch("");
        }}
      >
        <ListSubheader className="industry-filter-search">
          <TextField
            autoFocus
            size="small"
            placeholder="Search industries"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <div className="industry-filter-actions">
            <Button
              size="small"
              disabled={allSelected}
              onClick={() => setSelectedIndustryKeys(new Set(industries.map((industry) => industry.key)))}
            >
              Check all
            </Button>
            <Button
              size="small"
              disabled={selectedIndustryKeys.size === 0}
              onClick={() => setSelectedIndustryKeys(new Set())}
            >
              Uncheck all
            </Button>
          </div>
        </ListSubheader>
        {filteredIndustries.map((industry) => (
          <MenuItem key={industry.key} onClick={() => toggleIndustry(industry.key)}>
            <Checkbox size="small" checked={selectedIndustryKeys.has(industry.key)} />
            {industry.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
