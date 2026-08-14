import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import { Alert, Chip, Typography } from "@mui/material";
import type { ChangePreview as ChangePreviewData } from "../../api/tradeAnalyzer";

export function ChangePreview({ preview }: { preview: ChangePreviewData }) {
  return (
    <div className="change-preview" aria-label="Change preview">
      {preview.warnings.map((warning) => (
        <Alert key={warning} severity="warning" icon={<WarningAmberOutlinedIcon />}>
          {warning}
        </Alert>
      ))}
      <section>
        <Typography component="h3">Proposed changes</Typography>
        <div className="change-preview-grid">
          {preview.changes.map((change) => (
            <div key={change.label}>
              <strong>{change.label}</strong>
              <span>{change.before ?? "—"}</span>
              <span aria-hidden="true">→</span>
              <span>{change.after ?? "—"}</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <Typography component="h3">Affected trades</Typography>
        <div className="change-preview-trades">
          {preview.affected_trades.length === 0
            ? <Typography color="text.secondary">No trade changes.</Typography>
            : preview.affected_trades.map((trade) => (
              <Chip key={trade.id} label={`${trade.symbol} · ${trade.summary}`} />
            ))}
        </div>
      </section>
    </div>
  );
}
