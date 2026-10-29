export interface OwnershipProgress {
  active: boolean;
  phase: string;
  archive: string | null;
  completed: number;
  total: number;
  bytes_received: number;
  bytes_total: number | null;
  positions: number;
}

export interface FundPosition {
  report_date: string;
  filing_date: string;
  shares: number | null;
  ownership_percent: number | null;
  denominator_date: string | null;
  approximate: boolean;
  portfolio_weight: number | null;
  change_percent: number | null;
  status: "new" | "exited" | "added" | "reduced" | "unchanged" | "unknown" | "baseline";
  filing_url: string;
}

interface OwnershipQuarter {
  label: string;
  end_date: string;
  owners: number;
  owner_change_percent: number | null;
  increasing_quarters: number;
  reporting_funds: number;
  ownership_percent: number | null;
  ownership_approximate: boolean;
  new_owners: number;
  exited_owners: number;
  adding: number;
  reducing: number;
  comparable: number;
  unknown: number;
}

export interface FundOwnership {
  id: string;
  name: string;
  registrant_name: string;
  points: (FundPosition | null)[];
}

export interface InstitutionsReport {
  symbol: string;
  quarters: OwnershipQuarter[];
  funds: FundOwnership[];
  matched_cusips: string[];
  source_updated_at: string;
  source_url: string;
  warnings: string[];
  splits_verified: boolean;
}

type OwnershipEvent = { type: "progress"; progress: OwnershipProgress }
  | { type: "report"; report: InstitutionsReport }
  | { type: "error"; message: string };

export async function fetchInstitutions(
  symbol: string,
  refresh: boolean,
  signal: AbortSignal,
  onProgress: (progress: OwnershipProgress) => void,
): Promise<InstitutionsReport> {
  const response = await fetch(`/api/institutions/${encodeURIComponent(symbol)}${refresh ? "?refresh=true" : ""}`, { signal });
  if (!response.ok) throw new Error(`Could not load institutions: HTTP ${response.status}`);
  if (!response.body) throw new Error("Ownership response has no data stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 16 * 1024 * 1024) throw new Error("Ownership response is too large");
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (!line) continue;
        const event = JSON.parse(line) as OwnershipEvent;
        if (event.type === "progress") onProgress(event.progress);
        else if (event.type === "report") return event.report;
        else if (event.type === "error") throw new Error(event.message);
      }
      if (done) throw new Error("Ownership response ended before the report was ready. Try again.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
