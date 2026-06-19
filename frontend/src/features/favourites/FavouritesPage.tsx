import { useEffect, useState } from "react";
import { CircularProgress, Typography } from "@mui/material";
import { fetchFavourites } from "../../api/watchlists";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";

export function FavouritesPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

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
