import { useEffect, useRef, useState, type DragEvent } from "react";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import ContentPasteOutlinedIcon from "@mui/icons-material/ContentPasteOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import CloseIcon from "@mui/icons-material/Close";
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  clearTickerCollection,
  fetchLastTickerCollection,
  pasteTickerCollection,
  uploadTickerCollection,
  type TickerCollection,
} from "../../api/tickerCollections";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";
import { TickerStrengthControls } from "../ticker-strength/TickerStrengthControls";
import { TickerStrengthProvider } from "../ticker-strength/TickerStrengthContext";
import { useTickerStrengthFeature } from "../ticker-strength/useTickerStrengthMetric";
import "./csv-analyzer.css";

export function CsvAnalyzerPage() {
  return (
    <TickerStrengthProvider>
      <CsvAnalyzerContent />
    </TickerStrengthProvider>
  );
}

function CsvAnalyzerContent() {
  const tickerStrength = useTickerStrengthFeature();
  const [collection, setCollection] = useState<TickerCollection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [failedSymbols, setFailedSymbols] = useState<string[]>();
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchLastTickerCollection()
      .then(setCollection)
      .catch((loadError: unknown) => setError(errorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  const loadCollection = async (request: () => Promise<TickerCollection>) => {
    setLoading(true);
    setUploading(true);
    setError(undefined);
    try {
      setCollection(await request());
      setFailedSymbols(undefined);
      return true;
    } catch (uploadError) {
      setError(errorMessage(uploadError));
      return false;
    } finally {
      setLoading(false);
      setUploading(false);
      setDragging(false);
    }
  };

  const upload = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files).filter(isTickerFile);
    if (selectedFiles.length === 0) {
      setError("Drop CSV, TSV, or TXT files");
      return;
    }
    await loadCollection(() => uploadTickerCollection(selectedFiles));
  };

  const loadPastedTickers = async () => {
    if (await loadCollection(() => pasteTickerCollection(pastedText))) {
      setPasteOpen(false);
      setPastedText("");
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!loading) void upload(event.dataTransfer.files);
  };

  const clear = async () => {
    setLoading(true);
    try {
      await clearTickerCollection();
      setCollection(null);
      setFailedSymbols(undefined);
    } catch (clearError) {
      setError(errorMessage(clearError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <section
        className={`workspace-panel csv-analyzer-page${dragging ? " csv-analyzer-dragging" : ""}`}
        aria-label="CSV Analyzer"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <header className="panel-header csv-analyzer-header">
          <Typography component="h1">CSV Analyzer</Typography>
          <div className="csv-analyzer-ticker-strength">
            <TickerStrengthControls />
          </div>
          <div className="csv-analyzer-actions">
            {loading && !uploading && <CircularProgress size="0.85rem" />}
            {collection !== null && (
              <Typography className="csv-analyzer-summary">
                {summary(collection, failedSymbols?.length)}
              </Typography>
            )}
            <input
              ref={inputRef}
              hidden
              multiple
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              type="file"
              onChange={(event) => {
                if (event.target.files !== null) void upload(event.target.files);
                event.target.value = "";
              }}
            />
            <Tooltip title="Upload files">
              <span>
                <IconButton size="small" disabled={loading} aria-label="Upload files" onClick={() => inputRef.current?.click()}>
                  <UploadFileOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Paste tickers">
              <span>
                <IconButton size="small" disabled={loading} aria-label="Paste tickers" onClick={() => setPasteOpen(true)}>
                  <ContentPasteOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Clear collection">
              <span>
                <IconButton size="small" disabled={loading || collection === null} aria-label="Clear collection" onClick={clear}>
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Collection details">
              <span>
                <IconButton
                  size="small"
                  disabled={collection === null}
                  aria-label="Collection details"
                  onClick={() => setDetailsOpen(true)}
                >
                  <InfoOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </div>
        </header>
        {uploading ? (
          <div className="panel-status csv-analyzer-upload-status">
            <CircularProgress aria-label="Loading ticker collection" />
          </div>
        ) : collection === null ? (
          <div className="panel-status csv-analyzer-drop-target">
            <Typography color="text.secondary">
              Drop CSV/TXT files here, upload them, or paste tickers. Files use the
              first column for ticker symbols.
            </Typography>
          </div>
        ) : (
          <TickerLens
            accent="coral"
            universe={{ type: "bounded", symbols: collection.symbols }}
            metricExtensions={tickerStrength.metricExtensions}
            onBoundedResolution={setFailedSymbols}
          />
        )}
      </section>
      <Dialog
        open={pasteOpen}
        onClose={() => { if (!uploading) setPasteOpen(false); }}
        aria-labelledby="csv-paste-title"
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id="csv-paste-title">Paste tickers</DialogTitle>
        <DialogContent dividers>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={6}
            maxRows={12}
            label="Tickers"
            placeholder={"AAPL, MSFT; NVDA\nAMZN TSLA"}
            helperText="Separate tickers with spaces, commas, newlines, tabs, semicolons, or pipes."
            value={pastedText}
            disabled={uploading}
            onChange={(event) => setPastedText(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button disabled={uploading} onClick={() => setPasteOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={uploading || pastedText.trim() === ""} onClick={() => void loadPastedTickers()}>
            {uploading ? "Loading…" : "Load tickers"}
          </Button>
        </DialogActions>
      </Dialog>
      <CollectionDetailsDialog
        collection={collection}
        failedSymbols={failedSymbols}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
      <Toast message={error} onClose={() => setError(undefined)} />
    </>
  );
}

function CollectionDetailsDialog({
  collection,
  failedSymbols,
  open,
  onClose,
}: {
  collection: TickerCollection | null;
  failedSymbols?: string[];
  open: boolean;
  onClose: () => void;
}) {
  if (collection === null) return null;
  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="csv-collection-title" maxWidth="sm" fullWidth>
      <DialogTitle id="csv-collection-header" className="csv-collection-title">
        <span id="csv-collection-title">Ticker Collection</span>
        <IconButton size="small" aria-label="Close collection details" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent className="csv-collection-details" dividers>
        <Typography color="text.secondary">
          Created {new Date(collection.created_at).toLocaleString()}
        </Typography>
        <Typography>{collection.symbols.length} tickers · {collection.skipped_rows} skipped entries</Typography>
        {collection.source.type === "pasted" ? <Typography>Source: Pasted tickers</Typography> : collection.source.files.map((file) => (
          <Typography key={file.name}>
            {file.name}: {file.row_count} rows, {file.extracted_count} tickers, {file.skipped_rows} skipped
          </Typography>
        ))}
        {failedSymbols === undefined ? <Typography color="text.secondary">Resolving tickers…</Typography>
          : failedSymbols.length === 0 ? <Typography>All tickers resolved</Typography>
          : <Typography color="warning.main">Failed to resolve ({failedSymbols.length}): {failedSymbols.join(", ")}</Typography>}
        {collection.rejected_symbols.length > 0 && (
          <Typography color="warning.main">
            Rejected: {collection.rejected_symbols.map(item => `${item.symbol}: ${item.reason}`).join("; ")}
          </Typography>
        )}
        <Typography>Tickers: {collection.symbols.join(", ") || "None"}</Typography>
      </DialogContent>
    </Dialog>
  );
}

function summary(collection: TickerCollection, failedResolutionCount?: number) {
  const source = collection.source.type === "csv"
    ? collection.source.files.length === 1
      ? collection.source.files[0].name
      : `${collection.source.files.length} FILES`
    : "PASTED";
  const failed = failedResolutionCount === undefined ? ""
    : ` · ${failedResolutionCount} Failed`;
  return `${source} · ${collection.symbols.length} tickers${collection.rejected_symbols.length ? ` · ${collection.rejected_symbols.length} rejected` : ""}${failed}`;
}

function isTickerFile(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
