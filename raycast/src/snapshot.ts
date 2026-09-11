import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getPreferenceValues } from "@raycast/api";
import { collect, type Snapshot } from "@goso/core";

const run = promisify(execFile);

/**
 * Raycast's embedded Node has no `node:sqlite`, so the in-process collector
 * cannot read Antigravity's conversation databases. The CLI runs on Node 26
 * through mise and can, so we shell out to it when it is installed and fall
 * back to in-process collection (everything except Antigravity) when it is not.
 */
export interface SnapshotResult {
  snapshot: Snapshot;
  /** How the data was obtained, so the UI can explain a partial result. */
  via: "cli" | "in-process";
  /** Why the CLI was not used, when it was not. */
  fallbackReason?: string;
}

interface Preferences {
  cliPath?: string;
}

/** Raycast starts with a minimal PATH; add the usual places these tools live. */
const EXTRA_PATH = [
  path.join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCli(preferred: string | undefined): string | undefined {
  const candidates = [
    preferred?.trim().replace(/^~(?=\/|$)/, homedir()),
    ...EXTRA_PATH.map((dir) => path.join(dir, "goso")),
  ].filter((c): c is string => Boolean(c));

  return candidates.find(isExecutable);
}

export async function loadSnapshot(): Promise<SnapshotResult> {
  const { cliPath } = getPreferenceValues<Preferences>();
  const cli = resolveCli(cliPath);

  if (cli) {
    try {
      const { stdout } = await run(cli, ["--json"], {
        env: { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH].filter(Boolean).join(":") },
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { snapshot: JSON.parse(stdout) as Snapshot, via: "cli" };
    } catch (error) {
      return {
        snapshot: await collect(),
        via: "in-process",
        fallbackReason: `${cli} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    snapshot: await collect(),
    via: "in-process",
    fallbackReason:
      "goso CLI not found — symlink it onto your PATH (ln -s <repo>/bin/goso ~/.local/bin/goso) to include Antigravity",
  };
}
