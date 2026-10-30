import { useState } from "react";
import { isCancelledError, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MarketChartInterval } from "../../api/marketChart";
import {
  displayedStudyResult, expandedStudySelection, restoreStudyQueryOptions, studyPlaceholder,
  studyQueryKey, studyQueryOptions, studyScope, studySelection, type StudyRequest, type StudySelection,
} from "./studyQuery";

export function useStudyQuery(interval: MarketChartInterval, period: number) {
  const client = useQueryClient();
  const [initial] = useState({ interval, period });
  const [selected, setSelected] = useState<StudySelection>();
  const [datasetVersion, setDatasetVersion] = useState(0);
  const [dismissedError, setDismissedError] = useState<unknown>();
  const restoreOptions = restoreStudyQueryOptions(client, initial.interval, initial.period);
  const restored = useQuery({ ...restoreOptions, enabled: selected === undefined });
  const selection = selected ?? (restored.data == null ? undefined : studySelection(restored.data));
  const request = selection === undefined ? undefined : { ...selection, interval, period };
  const query = useQuery({ ...studyQueryOptions(client, request), placeholderData: previous => studyPlaceholder(previous, request) });
  const result = displayedStudyResult(client, request, query.data);
  const refresh = useMutation({
    mutationFn: async (resource: StudyRequest) => {
      await client.cancelQueries({ queryKey: studyScope(resource) });
      await client.invalidateQueries({ queryKey: studyScope(resource) }, { throwOnError: true });
    },
  });
  const currentError = query.error ?? (selected === undefined ? restored.error : null) ?? refresh.error;
  const error = currentError == null || currentError === dismissedError || isCancelledError(currentError) ? undefined
    : currentError instanceof Error ? currentError.message : "Unable to load Study";

  const select = (next: StudySelection) => {
    void client.cancelQueries({ queryKey: restoreOptions.queryKey, exact: true });
    setDismissedError(currentError);
    refresh.reset();
    setSelected(next);
    if (request !== undefined && JSON.stringify(studyQueryKey(request)) === JSON.stringify(studyQueryKey({ ...next, interval, period }))) {
      void query.refetch({ cancelRefetch: false });
    }
  };
  const historyLoading = query.isFetching && selected?.fetchRange !== undefined;
  return {
    result, selection, datasetVersion, error,
    loading: (selection === undefined && restored.isFetching) || (query.isFetching && !historyLoading) || refresh.isPending,
    historyLoading,
    dismissError: () => setDismissedError(currentError),
    load: (next: StudySelection) => { select(next); setDatasetVersion(version => version + 1); },
    refresh: () => { if (request !== undefined) { setDismissedError(currentError); refresh.mutate(request); } },
    loadHistory: (direction: "before" | "after") => {
      if (result === undefined || query.isFetching || refresh.isPending) return;
      const expanded = expandedStudySelection(result, direction);
      if (expanded !== undefined) select(expanded);
    },
  };
}
