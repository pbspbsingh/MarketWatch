export interface BuildInfo {
  version: string;
  built_at: number | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  mode: string;
}

export interface BackendBuildInfo extends BuildInfo {
  compiler: string;
  target: string;
}

export async function fetchBackendBuildInfo(signal?: AbortSignal): Promise<BackendBuildInfo> {
  const response = await fetch("/api/build-info", { signal, cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load backend build info: HTTP ${response.status}`);
  }
  return response.json() as Promise<BackendBuildInfo>;
}
