import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  LinearProgress,
  TextField,
  Typography,
} from "@mui/material";
import { Link } from "react-router-dom";
import {
  acceptThemeAudit,
  fetchThemeAudit,
  ignoreThemeAudit,
  retryRemainingThemeAudit,
  runEntireThemeAudit,
  type AiCapability,
  type ThemeAuditOverview,
} from "../../api/themes";
import { tickerMarketWatchUrl } from "../ticker-lens/utils";
import { errorMessage } from "./themeManagementUtils";

export function AuditTab({
  capability,
  onChanged,
  onError,
  onMessage,
}: {
  capability: AiCapability;
  onChanged: () => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}) {
  const [includeManual, setIncludeManual] = useState(false);
  const [overview, setOverview] = useState<ThemeAuditOverview>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setOverview(await fetchThemeAudit(includeManual));
  }, [includeManual]);

  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    const refresh = async () => {
      try {
        const next = await fetchThemeAudit(includeManual);
        if (!active) return;
        setOverview(next);
        timeout = window.setTimeout(refresh, next.progress?.status === "running" ? 2_500 : 10_000);
      } catch (loadError) {
        if (!active) return;
        onError(errorMessage(loadError));
        timeout = window.setTimeout(refresh, 10_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [includeManual, onError]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (runError) {
      onError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  const progress = overview?.progress;
  const running = progress?.status === "running";
  const auditedCount = overview?.audited_count ?? 0;
  const storedCount = overview?.stored_count ?? 0;
  const eligibleCount = overview?.eligible_count ?? 0;
  const remainingCount = Math.max(0, eligibleCount - auditedCount);

  return (
    <div className="theme-management-body audit-layout">
      <section className="assignment-card audit-controls">
        <div className="bulk-assignment-heading">
          <div>
            <Typography component="h2">Theme Assignment Audit</Typography>
            <Typography color="text.secondary">
              {auditedCount} of {eligibleCount} eligible tickers audited
            </Typography>
          </div>
          <div className="bulk-actions">
            <FormControlLabel
              control={(
                <Checkbox
                  checked={includeManual}
                  disabled={busy || running}
                  onChange={(event) => setIncludeManual(event.target.checked)}
                />
              )}
              label="Include manual assignments"
            />
            <Button
              disabled={busy || running || remainingCount === 0}
              onClick={() => void run(async () => {
                await retryRemainingThemeAudit(includeManual);
                await load();
                onMessage(`Auditing ${remainingCount} remaining tickers`);
              })}
            >
              Retry Remaining ({remainingCount})
            </Button>
            <Button
              variant="contained"
              disabled={busy || running || !capability.enabled || eligibleCount === 0}
              onClick={() => {
                if (
                  storedCount > 0
                  && !window.confirm(`Clear the existing audit and audit all ${eligibleCount} eligible tickers?`)
                ) return;
                void run(async () => {
                  await runEntireThemeAudit(includeManual);
                  await load();
                  onMessage(`Full audit started with ${capability.model ?? "configured AI"}`);
                });
              }}
            >
              {storedCount === 0 ? "Run Entire Audit" : "Re-run Entire Audit"}
            </Button>
          </div>
        </div>
        <Typography color="text.secondary">
          Uses {capability.model ?? "configured AI"} in batches of {capability.batch_size ?? "configured"}.
          Matching assignments are tracked but hidden below.
        </Typography>
        {progress && (
          <div className="audit-progress">
            <div className="audit-progress-summary">
              <Chip label={progress.status} color={progress.status === "incomplete" ? "warning" : "info"} />
              <span>{progress.batches_completed}/{progress.batches_total} batches</span>
              <span>{progress.audited}/{progress.total} audited</span>
              <span>{progress.discrepancies} discrepancies</span>
              {progress.failed > 0 && <span className="audit-error-count">{progress.failed} unaudited</span>}
            </div>
            <LinearProgress
              variant="determinate"
              value={progress.batches_total === 0
                ? 100
                : (progress.batches_completed / progress.batches_total) * 100}
            />
            {progress.active_batches.map((batch) => (
              <details key={batch.number} className="audit-stream">
                <summary>Batch {batch.number}: {batch.symbols.join(", ")}</summary>
                <div className="audit-stream-fields">
                  {batch.reasoning && (
                    <TextField fullWidth multiline label="Live reasoning" value={batch.reasoning} slotProps={{ input: { readOnly: true } }} />
                  )}
                  {batch.response && (
                    <TextField fullWidth multiline label="Live response" value={batch.response} slotProps={{ input: { readOnly: true } }} />
                  )}
                </div>
              </details>
            ))}
            {progress.recent_errors.length > 0 && (
              <details className="audit-errors">
                <summary>Recent audit errors</summary>
                {progress.recent_errors.map((auditError, index) => (
                  <Typography key={`${auditError}-${index}`} color="error">{auditError}</Typography>
                ))}
              </details>
            )}
          </div>
        )}
      </section>

      <section className="assignment-card audit-results">
        <Typography component="h2">Discrepancies ({overview?.results.length ?? 0})</Typography>
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Current</th>
                <th>Suggested</th>
                <th>Confidence</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {overview?.results.map((audit) => (
                <tr key={audit.symbol}>
                  <td>
                    <Link
                      to={tickerMarketWatchUrl(audit.symbol)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <strong>{audit.symbol}</strong>
                    </Link>
                  </td>
                  <td>{themeNames(audit.current_themes)}</td>
                  <td>{themeNames(audit.suggested_themes)}</td>
                  <td>{Math.round(audit.confidence * 100)}%</td>
                  <td>{audit.reasoning}</td>
                  <td><Chip size="small" label={audit.status} /></td>
                  <td>
                    {audit.status === "pending" && (
                      <div className="audit-row-actions">
                        <Button
                          size="small"
                          variant="contained"
                          disabled={busy}
                          onClick={() => {
                            if (
                              audit.suggested_themes.length === 0
                              && !window.confirm(`Remove every theme assignment from ${audit.symbol}?`)
                            ) return;
                            void run(async () => {
                              await acceptThemeAudit(audit.symbol);
                              await load();
                              onChanged();
                              onMessage(`${audit.symbol} audit suggestion accepted`);
                            });
                          }}
                        >
                          Accept
                        </Button>
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() => void run(async () => {
                            await ignoreThemeAudit(audit.symbol);
                            await load();
                            onMessage(`${audit.symbol} audit suggestion ignored`);
                          })}
                        >
                          Ignore
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function themeNames(themes: { name: string }[]) {
  return themes.length === 0 ? "No theme" : themes.map((theme) => theme.name).join(", ");
}
