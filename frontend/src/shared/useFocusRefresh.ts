import { useEffect, useRef, useState } from "react";

const focusEventDeduplicationMs = 250;

export function useFocusRefresh() {
  const [revision, setRevision] = useState(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefresh.current < focusEventDeduplicationMs) return;
      lastRefresh.current = now;
      setRevision((current) => current + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return revision;
}
