import {
  fetchIndustries,
  fetchThemeRankings,
} from "../../api/industries";
import type { GroupMode, GroupRanking } from "./types";

export function fetchGlobalGroupRankings(
  mode: GroupMode,
  signal?: AbortSignal,
): Promise<GroupRanking[]> {
  if (mode === "industry") {
    return fetchIndustries(signal).then((industries) =>
      industries.map(({ key, name, sector_key, sector_name, performance, absolute_strength }) => ({
        key,
        name,
        sector_key,
        sector_name,
        performance,
        absolute_strength,
      })),
    );
  }

  return fetchThemeRankings(signal).then((themes) =>
    themes.map(({ id, name, performance, absolute_strength }) => ({
      key: String(id),
      name,
      performance,
      absolute_strength,
    })),
  );
}
