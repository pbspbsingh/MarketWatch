export type VolumeRunRateTone = "unavailable" | "low" | "normal" | "high";

const LOW_MAXIMUM = 0.8;
const HIGH_MINIMUM = 1.1;

export function volumeRunRateTone(value?: number | null): VolumeRunRateTone {
  if (value === null || value === undefined) return "unavailable";
  if (value <= LOW_MAXIMUM) return "low";
  if (value < HIGH_MINIMUM) return "normal";
  return "high";
}
