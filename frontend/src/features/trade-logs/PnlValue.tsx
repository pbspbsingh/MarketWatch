import { money } from "./format";

export function PnlValue({ amount, returnPercent }: { amount: string | null; returnPercent?: number | null }) {
  return <>{money(amount)}{amount != null && returnPercent != null && <span className="tl-pnl-percent"> ({returnPercent > 0 ? "+" : ""}{returnPercent.toFixed(2)}%)</span>}</>;
}
