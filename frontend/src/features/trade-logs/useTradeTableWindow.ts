import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export function tableWindow(offsets: number[], scrollTop: number, height: number, overscan = 8) {
  const count = offsets.length - 1;
  const find = (position: number) => {
    let low = 0, high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle + 1] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const start = Math.max(0, Math.min(count, find(scrollTop)) - overscan);
  const end = Math.min(count, find(scrollTop + Math.max(0, height)) + overscan + 1);
  return { start, end, before: offsets[start], after: offsets[count] - offsets[end] };
}

/** Native table rows and spacer rows retain sticky headers, column alignment, and semantics. */
export function useTradeTableWindow(items: { key: string; kind: "trade" | "month" }[], selectedKey: string | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [sizes, setSizes] = useState({ trade: 40, month: 30, header: 32, columns: [] as number[] });
  const { trade: tradeHeight, month: monthHeight } = sizes;
  const offsets = useMemo(() => {
    const result = [0];
    for (const item of items) result.push(result.at(-1)! + (item.kind === "trade" ? tradeHeight : monthHeight));
    return result;
  }, [items, tradeHeight, monthHeight]);
  const updateViewport = useCallback(() => {
    const element = containerRef.current;
    if (element) setViewport(current => current.top === element.scrollTop && current.height === element.clientHeight
      ? current : { top: element.scrollTop, height: element.clientHeight });
  }, []);
  useLayoutEffect(() => {
    const container = containerRef.current, table = tableRef.current;
    if (!container || !table) return;
    const measure = () => {
      // A hidden pane has no measurable geometry; keep its last known sizes.
      if (!container.clientHeight) return;
      updateViewport();
      const trade = table.querySelector(".tl-trade-row")?.getBoundingClientRect().height;
      const month = table.querySelector(".tl-month-row")?.getBoundingClientRect().height;
      const header = table.tHead?.getBoundingClientRect().height;
      const columns = trade ? [...table.tHead!.rows[0].cells].map(cell => cell.getBoundingClientRect().width) : [];
      setSizes(current => {
        const next = { trade: trade || current.trade, month: month || current.month, header: header || current.header,
          columns: current.columns.length || !columns.length ? current.columns : columns };
        return next.trade === current.trade && next.month === current.month && next.header === current.header && next.columns === current.columns ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(table);
    return () => observer.disconnect();
  }, [updateViewport]);
  const selectedIndex = selectedKey === null ? -1 : items.findIndex(item => item.key === selectedKey);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || selectedIndex < 0 || !element.clientHeight) return;
    const height = element.clientHeight - sizes.header;
    const top = offsets[selectedIndex], bottom = offsets[selectedIndex + 1];
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + height) element.scrollTop = bottom - height;
    updateViewport();
  }, [selectedIndex, offsets, sizes.header, viewport.height, updateViewport]);
  return { containerRef, tableRef, columns: sizes.columns, onScroll: updateViewport,
    ...tableWindow(offsets, viewport.top, viewport.height - sizes.header) };
}
