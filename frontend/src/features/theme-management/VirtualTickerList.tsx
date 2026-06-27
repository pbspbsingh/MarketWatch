import { Checkbox, Chip } from "@mui/material";
import { List, type RowComponentProps } from "react-window";
import { type ThemeTicker } from "../../api/themes";

const rowHeight = 42;

interface TickerRowProps {
  tickers: ThemeTicker[];
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
  selectedSymbols,
  activeSymbol,
  onToggle,
  onOpen,
}: RowComponentProps<TickerRowProps>) {
  const ticker = tickers[index];
  const content = (
    <>
      <span>
        <strong>{ticker.symbol}</strong>
        <small>{ticker.name ?? "Unknown company"}</small>
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
