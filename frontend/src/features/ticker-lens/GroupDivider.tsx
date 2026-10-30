import { useRef } from "react";
import { collapsedGroupWidth, defaultGroupWidth, maximumGroupWidth, minimumGroupWidth } from "./constants";
import { useTickerLensState } from "./TickerLensState";
import type { GroupRanking } from "./types";

export function GroupDivider({ groups }: { groups: readonly GroupRanking[] }) {
  const width = useTickerLensState(state => state.preferences.groupWidth ?? defaultGroupWidth);
  const collapsed = useTickerLensState(state => state.preferences.groupsCollapsed ?? false);
  const mode = useTickerLensState(state => state.preferences.groupMode);
  const selectedKeys = useTickerLensState(state => state.selectedGroupKeys);
  const setWidth = useTickerLensState(state => state.setGroupWidth);
  const setCollapsed = useTickerLensState(state => state.setGroupsCollapsed);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; maxWidth: number } | null>(null);
  const title = mode === "industry" ? "Industries" : "Themes";
  const namesByKey = new Map(groups.map(group => [group.key, group.name]));
  const names = [...selectedKeys].map(key => namesByKey.get(key) ?? key).join(" · ");

  return <>
    {collapsed && <button
      type="button"
      className="ticker-lens-group-rail"
      aria-label={`Show ${title.toLowerCase()}${names ? `: ${names}` : ""}`}
      aria-controls="ticker-lens-group-panel"
      aria-expanded={false}
      title={names || "No groups selected"}
      onClick={() => setCollapsed(false)}
    >
      <span className="ticker-lens-group-rail-title">{title}</span>
      <span className="ticker-lens-group-rail-selection">{names || "No groups selected"}</span>
    </button>}
    <div
      className="ticker-lens-group-divider"
      role="separator"
      tabIndex={0}
      aria-label="Resize groups column"
      aria-controls="ticker-lens-group-panel"
      aria-orientation="vertical"
      aria-valuemin={collapsedGroupWidth}
      aria-valuemax={maximumGroupWidth}
      aria-valuenow={collapsed ? collapsedGroupWidth : Math.round(width)}
      aria-valuetext={collapsed ? "Groups collapsed" : `${Math.round(width)} pixels`}
      title="Drag to resize groups; drag left to fold. Double-click or Alt/Option+G to toggle."
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || drag.current !== null) return;
        const container = event.currentTarget.parentElement;
        if (container === null) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = {
          pointerId: event.pointerId, startX: event.clientX, startWidth: collapsed ? collapsedGroupWidth : width,
          maxWidth: Math.max(minimumGroupWidth, Math.min(maximumGroupWidth, container.clientWidth - defaultGroupWidth)),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        setWidth(Math.min(current.maxWidth, current.startWidth + event.clientX - current.startX));
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => setCollapsed(value => !value)}
      onKeyDown={event => {
        switch (event.key) {
          case "ArrowLeft": setWidth(collapsed ? 0 : width - 16); break;
          case "ArrowRight": setWidth(collapsed ? minimumGroupWidth : width + 16); break;
          case "Home": setCollapsed(true); break;
          case "End": setWidth(maximumGroupWidth); break;
          case "Enter": setCollapsed(value => !value); break;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  </>;
}
