import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { home } from "./util.ts";

/**
 * Small on-disk caches under ~/.cache/goso.
 *
 * The agents' own files are the source of truth; these only exist so a repeated
 * run — the Raycast menu bar refreshing, `--watch` ticking — does not redo work
 * whose inputs have not changed. Every entry carries a version so a change to
 * the cached shape invalidates it instead of being misread.
 */
export function cachePath(name: string): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  return xdg ? path.join(xdg, "goso", name) : home(".cache", "goso", name);
}

interface Envelope<T> {
  version: number;
  value: T;
}

export async function readCache<T>(name: string, version: number): Promise<T | undefined> {
  try {
    const envelope = JSON.parse(await readFile(cachePath(name), "utf8")) as Envelope<T>;
    return envelope.version === version ? envelope.value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCache<T>(name: string, version: number, value: T): Promise<void> {
  try {
    const file = cachePath(name);
    await mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename: a run interrupted mid-write must not leave a truncated
    // cache that the next run would silently read as complete.
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ version, value } satisfies Envelope<T>), { mode: 0o600 });
    await rename(temp, file);
  } catch {
    /* a cache miss is never fatal */
  }
}
