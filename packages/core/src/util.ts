import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function home(...parts: string[]): string {
  return path.join(homedir(), ...parts);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Recursively collect files matching `test`, newest first.
 * Directory recursion is capped so a stray deep tree cannot stall the CLI.
 */
export async function findFiles(
  root: string,
  test: (name: string) => boolean,
  opts: { maxDepth?: number; minMtimeMs?: number } = {},
): Promise<FileEntry[]> {
  const maxDepth = opts.maxDepth ?? 8;
  const out: FileEntry[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full, depth + 1);
        if (!entry.isFile() || !test(entry.name)) return;
        try {
          const st = await stat(full);
          if (opts.minMtimeMs !== undefined && st.mtimeMs < opts.minMtimeMs) return;
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished mid-walk */
        }
      }),
    );
  }

  await walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Read the last `bytes` of a file as text. Session logs append their newest
 * state at the end, so a tail read avoids parsing multi-megabyte histories.
 */
export async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length === 0) return "";
    const buf = Buffer.allocUnsafe(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString("utf8");
    // Drop a leading partial line when we did not start at byte 0.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

/** Floor an epoch-ms timestamp to the start of its UTC hour. */
export function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Read one protobuf varint. Returns the value and the next offset. */
export function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i]!;
    i += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 63) break;
  }
  return [result, i];
}

/** Parse durations like "4h19m9s" / "112h10m50s" into milliseconds. */
export function parseDuration(text: string): number | undefined {
  const match = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/.exec(text.trim());
  if (!match || match[0] === "") return undefined;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return undefined;
  return (Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000;
}

/**
 * Map over items with a bounded number in flight. Providers read dozens of
 * files; unbounded Promise.all opens them all at once, and a plain loop leaves
 * the disk idle between reads.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
