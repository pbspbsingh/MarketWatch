import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frontendDirectory = new URL("../", import.meta.url);

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: fileURLToPath(frontendDirectory),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function frontendBuildInfo(command, mode) {
  const { version } = JSON.parse(readFileSync(new URL("package.json", frontendDirectory), "utf8"));
  // The development server needs no Git subprocesses or production build metadata.
  if (command === "serve") {
    return {
      version,
      built_at: null,
      git_commit: null,
      git_dirty: null,
      mode: `${mode} (dev server)`,
    };
  }
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  return {
    version,
    built_at: Math.floor(Date.now() / 1000),
    git_commit: git(["rev-parse", "--verify", "HEAD"]),
    git_dirty: status === null ? null : status.length > 0,
    mode,
  };
}
