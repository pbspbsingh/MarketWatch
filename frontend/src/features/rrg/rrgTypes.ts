import type { ThemeRrgSeries } from "../../api/themes";

export type Quadrant = "leading" | "weakening" | "lagging" | "improving";

export const QUADRANTS = {
  leading: { label: "Leading", color: "rgba(40,180,80,0.09)", dot: "#2ecc71", text: "#2ecc71" },
  weakening: { label: "Weakening", color: "rgba(243,156,18,0.09)", dot: "#f39c12", text: "#f39c12" },
  lagging: { label: "Lagging", color: "rgba(220,50,50,0.09)", dot: "#e74c3c", text: "#e74c3c" },
  improving: { label: "Improving", color: "rgba(74,158,255,0.09)", dot: "#4a9eff", text: "#4a9eff" },
} as const;

export const QUADRANT_ORDER: Quadrant[] = ["leading", "improving", "weakening", "lagging"];

export function getQuadrant(rsRatio: number, rsMomentum: number): Quadrant {
  if (rsRatio >= 100 && rsMomentum >= 100) return "leading";
  if (rsRatio >= 100 && rsMomentum < 100) return "weakening";
  if (rsRatio < 100 && rsMomentum < 100) return "lagging";
  return "improving";
}

export type RrgItem = ThemeRrgSeries & {
  quadrant: Quadrant;
  rsRatio: number;
  rsMomentum: number;
};

export type RrgListItem = ThemeRrgSeries & {
  quadrant: Quadrant;
  rsRatio: number;
};

export type ExploreFilter = "unexplored" | "all";
