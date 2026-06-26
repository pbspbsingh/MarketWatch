import { useEffect, useState } from "react";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { Button, Chip, IconButton, TextField, Typography } from "@mui/material";
import { createTheme, deleteTheme, updateTheme, type Theme } from "../../api/themes";
import { errorMessage } from "./themeManagementUtils";

export function ThemesTab({
  themes,
  onChanged,
  onError,
  onMessage,
}: {
  themes: Theme[];
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<number>();
  const selected = themes.find((theme) => theme.id === selectedId);
  const [draft, setDraft] = useState({ name: "", etf_symbol: "", description: "" });

  useEffect(() => {
    setDraft({
      name: selected?.name ?? "",
      etf_symbol: selected?.etf_symbol ?? "",
      description: selected?.description ?? "",
    });
  }, [selected]);

  const save = async () => {
    try {
      const input = { ...draft, description: draft.description || null };
      if (selected === undefined) {
        const created = await createTheme(input);
        setSelectedId(created.id);
      } else {
        await updateTheme(selected.id, input);
      }
      onMessage(selected === undefined ? "Theme created" : "Theme updated");
      onChanged();
    } catch (saveError) {
      onError(errorMessage(saveError));
    }
  };

  const remove = async () => {
    if (selected === undefined) return;
    if (!window.confirm(`Delete ${selected.name} and its ${selected.stock_count} assignments?`)) return;
    try {
      await deleteTheme(selected.id);
      setSelectedId(undefined);
      onMessage("Theme deleted");
      onChanged();
    } catch (deleteError) {
      onError(errorMessage(deleteError));
    }
  };

  return (
    <div className="theme-management-body">
      <aside className="theme-list-pane">
        <div className="theme-pane-header">
          <Typography component="h2">Themes ({themes.length})</Typography>
          <IconButton
            size="small"
            aria-label="Add theme"
            onClick={() => {
              setSelectedId(undefined);
              setDraft({ name: "", etf_symbol: "", description: "" });
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </div>
        <ol className="theme-management-list">
          {themes.map((theme) => (
            <li key={theme.id}>
              <button
                className="theme-management-list-item"
                aria-pressed={theme.id === selectedId}
                onClick={() => setSelectedId(theme.id)}
              >
                <span>
                  <strong>{theme.name}</strong>
                  <small>{theme.etf_symbol}</small>
                </span>
                <Chip size="small" label={theme.stock_count} />
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <main className="theme-editor-pane">
        <div className="theme-editor-heading">
          <Typography component="h2">{selected === undefined ? "Add Theme" : "Edit Theme"}</Typography>
          {selected !== undefined && (
            <IconButton size="small" color="error" aria-label="Delete theme" onClick={remove}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          )}
        </div>
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
        <TextField
          label="ETF"
          value={draft.etf_symbol}
          onChange={(event) =>
            setDraft((current) => ({ ...current, etf_symbol: event.target.value.toUpperCase() }))
          }
        />
        <TextField
          multiline
          minRows={4}
          label="Description"
          value={draft.description}
          onChange={(event) =>
            setDraft((current) => ({ ...current, description: event.target.value }))
          }
        />
        <Button variant="contained" disabled={!draft.name.trim() || !draft.etf_symbol.trim()} onClick={save}>
          {selected === undefined ? "Create Theme" : "Save Changes"}
        </Button>
      </main>
    </div>
  );
}
