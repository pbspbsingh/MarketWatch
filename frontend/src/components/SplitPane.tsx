import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import "./split-pane.css";

export type SplitOrientation = "vertical" | "horizontal";

export function SplitPane({
  first,
  second,
  orientation = "vertical",
  initialSplit = 50,
  onSplitChange,
}: {
  first: ReactNode;
  second: ReactNode;
  orientation?: SplitOrientation;
  initialSplit?: number;
  onSplitChange?: (split: number) => void;
}) {
  const [split, setSplit] = useState(initialSplit);
  const rootRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef(split);

  const updateSplit = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    const total = orientation === "vertical" ? bounds.height : bounds.width;
    const offset = orientation === "vertical" ? event.clientY - bounds.top : event.clientX - bounds.left;
    if (total === 0) return;
    const next = Math.max(0, Math.min(100, (100 * offset) / total));
    splitRef.current = next;
    setSplit(next);
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onSplitChange?.(splitRef.current);
  };
  const template = `minmax(0, ${split}fr) 2px minmax(0, ${100 - split}fr)`;

  return (
    <div
      ref={rootRef}
      className={`split-pane split-pane-${orientation}`}
      style={orientation === "vertical" ? { gridTemplateRows: template } : { gridTemplateColumns: template }}
    >
      {first}
      <div
        className="split-pane-divider"
        role="separator"
        aria-orientation={orientation === "vertical" ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(split)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateSplit(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      />
      {second}
    </div>
  );
}
