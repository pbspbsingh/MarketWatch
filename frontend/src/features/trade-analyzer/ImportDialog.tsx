import { useRef, useState, type DragEvent } from "react";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from "@mui/material";
import {
  applyImport,
  previewImport,
  type ImportPreview,
  type ImportTradePreview,
  type TradeAnalyzerSnapshot,
} from "../../api/tradeAnalyzer";
import { ImportTradeTable } from "./ImportTradeTable";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onApplied: (snapshot: TradeAnalyzerSnapshot) => void;
  onError: (message: string) => void;
}

export function ImportDialog({ open, onClose, onApplied, onError }: ImportDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRequestRef = useRef(0);
  const [file, setFile] = useState<File>();
  const [broker, setBroker] = useState("thinkorswim");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [preview, setPreview] = useState<ImportPreview>();
  const [draftTrades, setDraftTrades] = useState<ImportTradePreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const selectFile = (selected?: File) => {
    if (selected === undefined || !selected.name.toLowerCase().endsWith(".csv")) {
      onError("Choose a CSV account statement");
      return;
    }
    setFile(selected);
    setPreview(undefined);
    setDraftTrades([]);
    void requestPreview(selected);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files[0]);
  };

  const requestPreview = async (
    selectedFile: File | undefined = file,
  ) => {
    if (selectedFile === undefined) return;
    const requestId = ++previewRequestRef.current;
    setBusy(true);
    try {
      const next = await previewImport(selectedFile, broker, timezone);
      if (previewRequestRef.current !== requestId) return;
      setPreview(next);
      setDraftTrades(next.trades);
    } catch (error) {
      if (previewRequestRef.current === requestId) onError(errorMessage(error));
    } finally {
      if (previewRequestRef.current === requestId) setBusy(false);
    }
  };

  const apply = async () => {
    if (file === undefined || preview === undefined) return;
    setBusy(true);
    try {
      onApplied(await applyImport(file, preview, draftTrades));
      onClose();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xl" fullWidth>
      <DialogTitle>Import broker statement</DialogTitle>
      <DialogContent dividers className="trade-dialog-content">
        <div className="trade-import-settings">
          <FormControl size="small">
            <InputLabel id="broker-format-label">Broker format</InputLabel>
            <Select
              labelId="broker-format-label"
              label="Broker format"
              value={broker}
              disabled={busy || preview !== undefined}
              onChange={(event) => setBroker(event.target.value)}
            >
              <MenuItem value="thinkorswim">thinkorswim</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="Statement timezone"
            value={timezone}
            disabled={busy}
            onChange={(event) => { setTimezone(event.target.value); setPreview(undefined); }}
            helperText="IANA timezone used by the broker statement"
          />
        </div>
        {preview === undefined ? (
          <div
            className={dragging ? "trade-import-drop trade-import-drop-active" : "trade-import-drop"}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <FileUploadOutlinedIcon />
            <Typography>{file?.name ?? "Drop a thinkorswim Account Statement CSV here"}</Typography>
            <Typography color="text.secondary">The statement is parsed without changing your trades.</Typography>
            <input
              ref={inputRef}
              hidden
              type="file"
              accept=".csv,text/csv,application/octet-stream"
              onChange={(event) => { selectFile(event.target.files?.[0]); event.target.value = ""; }}
            />
            <Button variant="outlined" size="small" onClick={() => inputRef.current?.click()}>
              Choose CSV
            </Button>
          </div>
        ) : (
          <>
            <div className="trade-import-preview-header">
              <div><small>Account</small><strong>{preview.account_label}</strong></div>
              <div><small>Statement range</small><strong>{preview.range_start} – {preview.range_end}</strong></div>
              <div><small>New</small><strong>{preview.counts.new}</strong></div>
              <div><small>Known</small><strong>{preview.counts.known}</strong></div>
              <div><small>Needs decision</small><strong>{preview.counts.unresolved + preview.counts.conflicts}</strong></div>
            </div>
            {preview.warnings.map((warning) => <Alert key={warning} severity="warning">{warning}</Alert>)}
            <ImportTradeTable trades={draftTrades} onChange={setDraftTrades} />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        {preview !== undefined && (
          <Button onClick={() => setPreview(undefined)} disabled={busy}>Back</Button>
        )}
        {preview === undefined && file !== undefined ? (
          <Button variant="contained" disabled={busy} onClick={() => void requestPreview()}>
            {busy ? "Preparing…" : "Retry preview"}
          </Button>
        ) : preview !== undefined ? (
          <Button variant="contained" disabled={busy || !draftTrades.some((trade) => trade.included)} onClick={() => void apply()}>
            {busy ? "Applying…" : `Import ${draftTrades.filter((trade) => trade.included).length} trades`}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
