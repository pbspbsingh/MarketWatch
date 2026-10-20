import { Button, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from "@mui/material";
import type { TradeLogSnapshot } from "../../api/tradeLogs";
import { Metric } from "./TradeEditor";
import { money, percent, pnlClass } from "./format";

export function TradeStatistics({ snapshot, onTag }: { snapshot: TradeLogSnapshot; onTag: (id: number) => void }) {
  const stats = snapshot.statistics;
  const rows = snapshot.tag_statistics.filter(row => row.statistics.closed_trades > 0).sort((a, b) => Number(b.statistics.net_pnl) - Number(a.statistics.net_pnl));
  return <div className="tl-statistics">
    <div className="tl-section-heading"><div><h2>Performance</h2><p className="tl-caption">Closed trades only. All figures include fees. Filters apply to this entire view.</p></div></div>
    <div className="tl-stat-grid">
      <Metric label="Net P&L" value={money(stats.net_pnl)} className={pnlClass(stats.net_pnl)} />
      <Metric label="Win rate" value={percent(stats.win_rate)} />
      <Metric label="Profit factor" value={stats.profit_factor?.toFixed(2) ?? "—"} />
      <Metric label="Closed trades" value={stats.closed_trades} />
      <Metric label="Average trade" value={money(stats.average_pnl)} />
      <Metric label="Average winner" value={money(stats.average_winner)} />
      <Metric label="Average loser" value={money(stats.average_loser)} />
      <Metric label="Wins / losses / breakeven" value={`${stats.winners} / ${stats.losers} / ${stats.breakeven}`} />
    </div>
    <p className="tl-caption">Win rate includes breakeven trades in the denominator. Profit factor is unavailable when there are no losses.</p>
    <div className="tl-open-stats"><Metric label="Open positions" value={snapshot.open_trades} /><Metric label="Realized P&L on open positions" value={money(snapshot.open_realized_pnl)} className={pnlClass(snapshot.open_realized_pnl)} /><p className="tl-caption">Partial exits from open positions are shown separately until the trade closes. Unrealized P&L is excluded.</p></div>
    <section className="tl-tag-stats"><div className="tl-section-heading"><div><h3>Performance by tag</h3><p className="tl-caption">Each matching trade counts once per tag. A trade can appear in multiple rows; rows are not additive. Scope follows the tag source filter.</p></div></div>
      <TableContainer><Table size="small" aria-label="Statistics by tag"><TableHead><TableRow><TableCell>Tag</TableCell><TableCell align="right">Closed</TableCell><TableCell align="right">Win rate</TableCell><TableCell align="right">Net P&L</TableCell><TableCell align="right">Avg. trade</TableCell><TableCell align="right">Profit factor</TableCell></TableRow></TableHead>
        <TableBody>{rows.map(({ tag_id, statistics: row }) => <TableRow key={tag_id} hover><TableCell><Button size="small" onClick={() => onTag(tag_id)}>{snapshot.tags.find(tag => tag.id === tag_id)?.name}</Button></TableCell><TableCell align="right">{row.closed_trades}</TableCell><TableCell align="right">{percent(row.win_rate)}</TableCell><TableCell align="right" className={pnlClass(row.net_pnl)}>{money(row.net_pnl)}</TableCell><TableCell align="right">{money(row.average_pnl)}</TableCell><TableCell align="right">{row.profit_factor?.toFixed(2) ?? "—"}</TableCell></TableRow>)}</TableBody>
      </Table></TableContainer>
      {!rows.length && <div className="tl-empty-small">Close a tagged trade to see its performance here.</div>}
      <p className="tl-caption">{snapshot.untagged_trades} trade(s) in the current view have no trade or execution tags. Tag results describe associations with whole-trade outcomes.</p>
    </section>
  </div>;
}
