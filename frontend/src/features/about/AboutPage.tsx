import { useEffect, useState } from "react";
import { Alert, Button, CircularProgress, Typography } from "@mui/material";
import {
  fetchBackendBuildInfo,
  type BackendBuildInfo,
  type BuildInfo,
} from "../../api/buildInfo";
import "./about.css";

const buildTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
});
const localTimeZone = buildTimeFormatter.resolvedOptions().timeZone;

function BuildDetails({ info }: { info: BuildInfo | BackendBuildInfo }) {
  const developmentBuild = "compiler" in info ? info.mode !== "release" : info.built_at === null;
  const gitUnavailable = developmentBuild
    ? "Not collected in development"
    : "Unavailable";
  const rows = [
    ["Version", info.version],
    ["Built at", info.built_at === null
      ? "Not built (development server)"
      : buildTimeFormatter.format(new Date(info.built_at * 1000))],
    ["Build mode", info.mode],
    ["Git commit", info.git_commit ?? gitUnavailable],
    ["Source changes", info.git_dirty === null
      ? gitUnavailable
      : info.git_dirty ? "Uncommitted changes" : "Clean"],
    ...("compiler" in info ? [
      ["Compiler", info.compiler],
      ["Target", info.target],
    ] : []),
  ];

  return (
    <dl className="about-build-details">
      {rows.map(([label, value]) => (
        <div className="about-build-row" key={label}>
          <dt>{label}</dt>
          <dd className={label === "Git commit" ? "about-build-commit" : undefined}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AboutPage() {
  const [backend, setBackend] = useState<BackendBuildInfo>();
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchBackendBuildInfo(controller.signal)
      .then(setBackend)
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load backend build info");
      });
    return () => controller.abort();
  }, [request]);

  return (
    <div className="about-page">
      <header className="about-header">
        <Typography component="h1">About MarketWatch</Typography>
      </header>
      <div className="about-content">
        <Typography component="p" color="text.secondary" className="about-timezone">
          Build information · Times shown in {localTimeZone}
        </Typography>
        <div className="about-build-grid">
          <section className="about-build-card" aria-labelledby="about-backend-title">
            <Typography component="h2" id="about-backend-title">Backend</Typography>
            {backend ? <BuildDetails info={backend} /> : error ? (
              <Alert
                severity="error"
                action={(
                  <Button color="inherit" size="small" onClick={() => {
                    setError(undefined);
                    setRequest((current) => current + 1);
                  }}>Retry</Button>
                )}
              >
                {error}
              </Alert>
            ) : (
              <div className="about-build-loading" role="status">
                <CircularProgress size="1rem" />
                <Typography color="text.secondary">Loading backend build info</Typography>
              </div>
            )}
          </section>
          <section className="about-build-card" aria-labelledby="about-frontend-title">
            <Typography component="h2" id="about-frontend-title">Frontend</Typography>
            <BuildDetails info={__FRONTEND_BUILD_INFO__} />
          </section>
        </div>
      </div>
    </div>
  );
}
