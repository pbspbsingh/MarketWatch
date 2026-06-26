import { Button, Chip, CircularProgress, Typography } from "@mui/material";
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
  onToggleTheme,
  onSave,
  onSuggest,
}: TickerProfileThemesTabProps) {
  const suggestion = suggestions[0];

  return (
    <div className="profile-themes-tab">
      <section className="ticker-details-profile">
        <Typography component="h3">
          {details.profile.name ?? details.profile.symbol}
        </Typography>
        <Typography className="company-description" color="text.secondary">
          {details.profile.description ?? "No company description available."}
        </Typography>
      </section>
      <section className="ticker-theme-panel">
        <div className="ticker-theme-heading">
          <Typography component="h3">Themes</Typography>
          {loading ? <CircularProgress size="1rem" /> : null}
        </div>
        <Typography color="text.secondary">
          Prefer one theme. Select a second only for a distinct, material business driver.
        </Typography>
        <div className="theme-chip-grid">
          {themes.map((theme) => (
            <Chip
              key={theme.id}
              clickable
              color={
                draftThemeIds.includes(theme.id) && suggestedThemeIds.includes(theme.id)
                  ? "secondary"
                  : draftThemeIds.includes(theme.id)
                    ? "primary"
                    : "default"
              }
              variant={draftThemeIds.includes(theme.id) ? "filled" : "outlined"}
              label={`${theme.name} · ${theme.etf_symbol}`}
              onClick={() => onToggleTheme(theme.id)}
            />
          ))}
        </div>
        <Button
          variant="contained"
          disabled={saving || loading || themeTicker === undefined}
          onClick={onSave}
        >
          Save Manual Assignment
        </Button>
      </section>
      <section className="ticker-theme-panel ticker-ai-panel">
        <div className="ticker-theme-heading">
          <Typography component="h3">AI Suggestion</Typography>
          <Button
            disabled={!aiCapability.enabled || suggesting || loading || themes.length === 0}
            onClick={onSuggest}
            startIcon={suggesting ? <CircularProgress size="0.8rem" /> : undefined}
          >
            {suggesting ? "Suggesting..." : "Suggest Themes"}
          </Button>
        </div>
        <Typography color="text.secondary">
          {aiCapability.enabled
            ? `Uses ${aiCapability.model ?? "configured AI"}. Suggested themes are selected above; Save writes them.`
            : "AI suggestions are disabled because AI is not configured."}
        </Typography>
        {suggestion !== undefined ? (
          <div className="ticker-ai-preview">
            <Typography component="h4">Latest suggestion</Typography>
            <Typography>
              {suggestion.themes.length > 0 ? suggestion.themes.join(", ") : "No theme"}
            </Typography>
            {suggestion.reasoning ? (
              <Typography color="text.secondary">{suggestion.reasoning}</Typography>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
