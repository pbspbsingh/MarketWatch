import { useEffect, useRef, useState, type DragEvent } from "react";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Typography,
} from "@mui/material";
import {
  clearTickerCollection,
  fetchLastTickerCollection,
  uploadTickerCollection,
  type TickerCollection,
} from "../../api/tickerCollections";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";
import "./csv-analyzer.css";

export function CsvAnalyzerPage() {
  const [collection, setCollection] = useState<TickerCollection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [failedResolutionCount, setFailedResolutionCount] = useState(0);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    fetchLastTickerCollection()
      .then(setCollection)
      .catch((loadError: unknown) => setError(errorMessage(loadError)))
      .finally(() => setLoading(false));
  }, []);

  const upload = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files).filter(isTickerFile);
    if (selectedFiles.length === 0) {
      setError("Drop CSV, TSV, or TXT files");
      return;
    }
    setLoading(true);
    setUploadProgress(0);
    try {
      setCollection(await uploadTickerCollection(selectedFiles, setUploadProgress));
      setFailedResolutionCount(0);
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setLoading(false);
      setUploadProgress(undefined);
      setDragging(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void upload(event.dataTransfer.files);
  };

  const clear = async () => {
    setLoading(true);
    try {
      await clearTickerCollection();
      setCollection(null);
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
          <div className="csv-analyzer-actions">
            {loading && <CircularProgress size="0.85rem" />}
            {collection !== null && (
              <Typography className="csv-analyzer-summary">
                {summary(collection, failedResolutionCount)}
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
            <Button size="small" onClick={() => inputRef.current?.click()}>
              Upload
            </Button>
            <Button size="small" disabled={collection === null} onClick={clear}>
              Clear
            </Button>
            <IconButton
              size="small"
              disabled={collection === null}
              aria-label="Collection details"
              onClick={() => setDetailsOpen(true)}
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          </div>
        </header>
        {uploadProgress !== undefined ? (
          <div className="panel-status csv-analyzer-upload-status">
            <LinearProgress
              className="csv-analyzer-upload-progress"
              variant="determinate"
              value={uploadProgress}
              aria-label="File upload progress"
            />
          </div>
        ) : collection === null ? (
          <div className="panel-status csv-analyzer-drop-target">
            <Typography color="text.secondary">
              Drop CSV/TXT files here or upload them. The backend reads tickers from the
              first column.
            </Typography>
          </div>
        ) : (
          <TickerLens
            accent="coral"
            universe={{ type: "bounded", symbols: collection.symbols }}
            onBoundedResolution={setFailedResolutionCount}
          />
        )}
      </section>
      <CollectionDetailsDialog
        collection={collection}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
      <Toast message={error} onClose={() => setError(undefined)} />
    </>
  );
}

function CollectionDetailsDialog({
  collection,
  open,
  onClose,
}: {
  collection: TickerCollection | null;
  open: boolean;
  onClose: () => void;
}) {
  if (collection === null) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>CSV Collection</DialogTitle>
      <DialogContent dividers>
        <Typography color="text.secondary">
          Created {new Date(collection.created_at).toLocaleString()}
        </Typography>
        {collection.source.files.map((file) => (
          <Typography key={file.name}>
            {file.name}: {file.extracted_count} tickers, {file.skipped_rows} skipped
          </Typography>
        ))}
      </DialogContent>
    </Dialog>
  );
}

function summary(collection: TickerCollection, failedResolutionCount: number) {
  const fileCount = collection.source.files.length;
  const skipped = collection.skipped_rows > 0 ? ` · ${collection.skipped_rows} skipped` : "";
  const failed =
    failedResolutionCount > 0
      ? ` · ${failedResolutionCount} resolution${failedResolutionCount === 1 ? "" : "s"} failed`
      : "";
  return `${collection.symbols.length} tickers · ${fileCount} files${skipped}${failed}`;
}

function isTickerFile(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
