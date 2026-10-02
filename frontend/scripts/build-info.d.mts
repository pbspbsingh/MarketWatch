import type { BuildInfo } from "../src/api/buildInfo";

export function frontendBuildInfo(command: "build" | "serve", mode: string): BuildInfo;
