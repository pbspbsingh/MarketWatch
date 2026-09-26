import type { ReactNode } from "react";
import { Checkbox, Chip } from "@mui/material";
import { List, type RowComponentProps } from "react-window";
import { type ThemeTicker } from "../../api/themes";
import { matchThemeTicker, type MatchRange } from "./themeManagementUtils";

const rowHeight = 42;

interface TickerRowProps {
  tickers: ThemeTicker[];
  search: string;
  selectedSymbols: Set<string>;
  activeSymbol?: string;
  onToggle: (symbol: string) => void;
  onOpen?: (symbol: string) => void;
}

function TickerRow({
  index,
  style,
  ariaAttributes,
  tickers,
  search,
  selectedSymbols,
  activeSymbol,
  onToggle,
  onOpen,
}: RowComponentProps<TickerRowProps>) {
  const ticker = tickers[index];
  const match = matchThemeTicker(ticker, search);
  const content = (
    <>
      <span>
        <strong>
          <HighlightedText label={ticker.symbol} ranges={match?.symbolRanges ?? []} />
        </strong>
        <small>
          <HighlightedText label={ticker.name ?? "Unknown company"} ranges={match?.nameRanges ?? []} />
        </small>
      </span>
      <Chip size="small" label={ticker.assignments.length} />
    </>
  );

  return (
    <div style={style} {...ariaAttributes}>
      <div className="ticker-assignment-row">
        <Checkbox
          size="small"
          checked={selectedSymbols.has(ticker.symbol)}
          onChange={() => onToggle(ticker.symbol)}
        />
        {onOpen ? (
          <button
            className="theme-management-list-item"
            aria-pressed={ticker.symbol === activeSymbol}
            onClick={() => onOpen(ticker.symbol)}
          >
            {content}
          </button>
        ) : (
          <div className="theme-management-list-item">{content}</div>
        )}
      </div>
    </div>
  );
}

function HighlightedText({ label, ranges }: { label: string; ranges: MatchRange[] }): ReactNode {
  if (ranges.length === 0) return label;
  const parts: ReactNode[] = [];
  let position = 0;
  for (const [start, end] of ranges) {
    if (start > position) parts.push(label.slice(position, start));
    parts.push(<mark key={`${start}-${end}`}>{label.slice(start, end)}</mark>);
    position = end;
  }
  if (position < label.length) parts.push(label.slice(position));
  return parts;
}

export function VirtualTickerList(props: TickerRowProps) {
  return (
    <List
      className="theme-management-list virtual-ticker-list"
      rowComponent={TickerRow}
      rowCount={props.tickers.length}
      rowHeight={rowHeight}
      rowProps={props}
      overscanCount={6}
    />
  );
}
