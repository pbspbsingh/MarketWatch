import { useEffect, useRef, useState, type PointerEvent } from "react";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { CircularProgress, IconButton, Tooltip, Typography } from "@mui/material";
import { fetchTickerDetails } from "../../api/details";
import { fetchFavourites } from "../../api/watchlists";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";

const downloadButtonInset = 8;
const downloadButtonPositionKey = "market-watch.favourites-download-position";

interface FloatingPosition {
  left: number;
  top: number;
}

function initialDownloadButtonPosition(): FloatingPosition {
  const stored = localStorage.getItem(downloadButtonPositionKey);
  if (stored !== null) {
    try {
      const position = JSON.parse(stored) as Partial<FloatingPosition>;
      if (Number.isFinite(position.left) && Number.isFinite(position.top)) {
        return { left: position.left!, top: position.top! };
      }
    } catch {
      // Ignore an invalid saved position.
    }
  }
  return { left: window.innerWidth - 48, top: window.innerHeight - 48 };
}

function localDateFileName() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}.csv`;
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function FavouritesPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string>();
  const [downloadPosition, setDownloadPosition] = useState(initialDownloadButtonPosition);
  const downloadButtonRef = useRef<HTMLButtonElement>(null);
  const downloadDrag = useRef({
    pointerId: 0,
    startX: 0,
    startY: 0,
    startPosition: { left: 0, top: 0 },
    currentPosition: { left: 0, top: 0 },
    moved: false,
  });

  const clampDownloadPosition = (position: FloatingPosition): FloatingPosition => {
    const width = downloadButtonRef.current?.offsetWidth ?? 32;
    const height = downloadButtonRef.current?.offsetHeight ?? 32;
    const maximumLeft = Math.max(downloadButtonInset, window.innerWidth - width - downloadButtonInset);
    const maximumTop = Math.max(downloadButtonInset, window.innerHeight - height - downloadButtonInset);
    return {
      left: Math.min(Math.max(position.left, downloadButtonInset), maximumLeft),
      top: Math.min(Math.max(position.top, downloadButtonInset), maximumTop),
    };
  };

  useEffect(() => {
    const clampPosition = () => setDownloadPosition((position) => clampDownloadPosition(position));
    clampPosition();
    window.addEventListener("resize", clampPosition);
    return () => window.removeEventListener("resize", clampPosition);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchFavourites(controller.signal)
      .then((nextSymbols) => {
        if (!controller.signal.aborted) setSymbols(nextSymbols);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const download = async () => {
    setDownloading(true);
    setDownloadProgress(0);
    setError(undefined);
    try {
      const rows: [string, string][] = [];
      for (const [index, symbol] of symbols.entries()) {
        const details = await fetchTickerDetails(symbol);
        rows.push([symbol, details.profile.name ?? ""]);
        setDownloadProgress(((index + 1) / symbols.length) * 100);
      }
      const csv = ["symbol,name", ...rows.map(([symbol, name]) => `${csvCell(symbol)},${csvCell(name)}`)].join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = localDateFileName();
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Failed to download favourites CSV");
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || downloading) return;
    downloadDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: downloadPosition,
      currentPosition: downloadPosition,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDownloadPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = downloadDrag.current;
    if (event.pointerId !== drag.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const left = drag.startPosition.left + event.clientX - drag.startX;
    const top = drag.startPosition.top + event.clientY - drag.startY;
    if (Math.abs(event.clientX - drag.startX) >= 4 || Math.abs(event.clientY - drag.startY) >= 4) {
      drag.moved = true;
      drag.currentPosition = clampDownloadPosition({ left, top });
      setDownloadPosition(drag.currentPosition);
    }
  };

  const handleDownloadPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = downloadDrag.current;
    if (event.pointerId !== drag.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      localStorage.setItem(downloadButtonPositionKey, JSON.stringify(drag.currentPosition));
    }
  };

  const handleDownloadClick = () => {
    if (downloadDrag.current.moved) {
      downloadDrag.current.moved = false;
      return;
    }
    void download();
  };

  if (loading) {
    return (
      <section className="bounded-empty-page">
        <CircularProgress size="1rem" />
        <Typography color="text.secondary">Loading favourites</Typography>
      </section>
    );
  }

  if (symbols.length === 0) {
    return (
      <section className="bounded-empty-page">
        <Typography component="h1">Favourites</Typography>
        <Typography color="text.secondary">No favourite tickers yet</Typography>
        <Toast message={error} onClose={() => setError(undefined)} />
      </section>
    );
  }

  return (
    <>
      <Tooltip
        title={
          downloading ? `Preparing favourites CSV (${Math.round(downloadProgress)}%)` : "Download favourites CSV"
        }
      >
        <IconButton
          ref={downloadButtonRef}
          className="favourites-download"
          aria-label="Download favourites CSV"
          disabled={downloading}
          style={downloadPosition}
          onPointerDown={handleDownloadPointerDown}
          onPointerMove={handleDownloadPointerMove}
          onPointerUp={handleDownloadPointerUp}
          onPointerCancel={handleDownloadPointerUp}
          onClick={handleDownloadClick}
        >
          {downloading ? (
            <CircularProgress size="1rem" variant="determinate" value={downloadProgress} />
          ) : (
            <FileDownloadIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
      <TickerLens
        accent="yellow"
        universe={{ type: "bounded", symbols }}
        onFavouriteChange={(symbol, isFavourite) => {
          if (isFavourite) return;
          setSymbols((current) => current.filter((currentSymbol) => currentSymbol !== symbol));
        }}
      />
      <Toast message={error} onClose={() => setError(undefined)} />
    </>
  );
}
