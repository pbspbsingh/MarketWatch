import { useEffect, useRef, useState } from "react";
import { Button, Chip, CircularProgress, TextField, Typography } from "@mui/material";
import type {
  AiCapability,
  Theme,
  ThemeSuggestion,
  ThemeTicker,
} from "../api/themes";
import type { TickerDetails } from "../api/details";

interface TickerProfileThemesTabProps {
  details: TickerDetails;
  themes: Theme[];
  themeTicker: ThemeTicker | undefined;
  draftThemeIds: number[];
  suggestedThemeIds: number[];
  aiCapability: AiCapability;
  loading: boolean;
  saving: boolean;
  suggesting: boolean;
  suggestions: ThemeSuggestion[];
  liveReasoning: string;
  liveResponse: string;
  onToggleTheme: (themeId: number) => void;
  onSave: () => void;
  onSuggest: () => void;
}

export function TickerProfileThemesTab({
  details,
  themes,
  themeTicker,
  draftThemeIds,
  suggestedThemeIds,
  aiCapability,
  loading,
  saving,
  suggesting,
  suggestions,
  liveReasoning,
  liveResponse,
  onToggleTheme,
  onSave,
  onSuggest,
}: TickerProfileThemesTabProps) {
  const [search, setSearch] = useState("");
  const streamPanelRef = useRef<HTMLDivElement>(null);
  const suggestion = suggestions[0];
  const latestSuggestionText = suggestion === undefined ? "" : [
    suggestion.themes.length > 0 ? suggestion.themes.join(", ") : "No theme",
    suggestion.reasoning,
  ].filter(Boolean).join("\n\n");
  const selectedThemes = themes.filter((theme) => draftThemeIds.includes(theme.id));
  const savedThemeIds = themeTicker?.assignments.map((assignment) => assignment.theme_id) ?? [];
  const hasAssignmentChanges = themeTicker !== undefined && (
    draftThemeIds.length !== savedThemeIds.length
    || draftThemeIds.some((id) => !savedThemeIds.includes(id))
  );
  const visibleThemes = themes.filter((theme) =>
    !draftThemeIds.includes(theme.id)
    && `${theme.name} ${theme.etf_symbol}`.toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    if (suggesting && streamPanelRef.current) {
      streamPanelRef.current.scrollTop = streamPanelRef.current.scrollHeight;
    }
  }, [liveReasoning, liveResponse, suggesting]);

  return (
    <div className="profile-themes-tab">
      <section className="ticker-details-profile">
        <Typography component="h3">Company profile</Typography>
        <Typography className="ticker-profile-name">
          {details.profile.name ?? details.profile.symbol}
        </Typography>
        <Typography className="company-description" color="text.secondary">
          {details.profile.description ?? "No company description available."}
        </Typography>
      </section>
      <section className="ticker-theme-panel ticker-theme-assignment">
        <div className="ticker-theme-heading">
          <Typography component="h3">Theme assignment</Typography>
          {loading ? <CircularProgress size="1rem" /> : null}
        </div>
        <Typography color="text.secondary">
          Prefer one theme. Select a second only for a distinct, material business driver.
        </Typography>
        <div className="ticker-theme-selected">
          <Typography component="h4">Selected ({selectedThemes.length}/2)</Typography>
          <div className="ticker-theme-selected-row">
            <div className="theme-chip-grid">
              {selectedThemes.length === 0 ? (
                <Typography color="text.secondary">No themes selected</Typography>
              ) : selectedThemes.map((theme) => (
                <Chip
                  key={theme.id}
                  color={suggestedThemeIds.includes(theme.id) ? "secondary" : "primary"}
                  disabled={saving || suggesting}
                  label={`${theme.name} · ${theme.etf_symbol}`}
                  onDelete={() => onToggleTheme(theme.id)}
                />
              ))}
            </div>
            <Button
              size="small"
              variant="contained"
              disabled={saving || suggesting || loading || !hasAssignmentChanges}
              onClick={onSave}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
        <TextField
          size="small"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search themes"
          slotProps={{ htmlInput: { "aria-label": "Search themes" } }}
        />
        <div className="theme-chip-grid">
          {visibleThemes.map((theme) => (
            <Chip
              key={theme.id}
              clickable
              disabled={saving || suggesting}
              variant="outlined"
              label={`${theme.name} · ${theme.etf_symbol}`}
              onClick={() => onToggleTheme(theme.id)}
            />
          ))}
          {!loading && visibleThemes.length === 0 && (
            <Typography color="text.secondary">No matching themes</Typography>
          )}
        </div>
        <div className="ticker-ai-panel">
          <div className="ticker-theme-heading">
            <Typography component="h3">AI Suggestion</Typography>
            <Button
              disabled={!aiCapability.enabled || saving || suggesting || loading || themes.length === 0}
              onClick={onSuggest}
              startIcon={suggesting ? <CircularProgress size="0.8rem" /> : undefined}
            >
              {suggesting ? "Suggesting..." : "Suggest Themes"}
            </Button>
          </div>
          <Typography color="text.secondary">
            {aiCapability.enabled
              ? `Uses ${aiCapability.model ?? "configured AI"}. Review the suggestion before saving.`
              : "AI suggestions are disabled because AI is not configured."}
          </Typography>
          {(suggesting || liveReasoning) && (
            <div className="ticker-ai-preview" ref={streamPanelRef}>
              <Typography component="h4">
                {liveReasoning ? "Model reasoning" : liveResponse ? "Generating suggestion" : "Waiting for AI"}
              </Typography>
              <Typography component="pre" className="ticker-ai-stream">
                {liveReasoning || liveResponse || "The AI request is in progress…"}
              </Typography>
            </div>
          )}
          {suggestion !== undefined ? (
            <div className="ticker-ai-preview">
              <Typography component="h4">Latest suggestion</Typography>
              <Typography component="pre" className="ticker-ai-stream">
                {latestSuggestionText}
              </Typography>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
