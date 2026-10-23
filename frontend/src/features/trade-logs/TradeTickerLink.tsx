import { Link } from "@mui/material";
import type { TradeLog } from "../../api/tradeLogs";

export function TradeTickerLink({ trade }: { trade: Pick<TradeLog, "id" | "symbol"> }) {
  return <Link href={`/market-watch?ticker=${encodeURIComponent(trade.symbol)}&trade_id=${trade.id}`}
    target="_blank" rel="noopener noreferrer" underline="hover"
    title={`Open ${trade.symbol} in Market Watch in a new tab`}
    onClick={event => event.stopPropagation()}>{trade.symbol}</Link>;
}
