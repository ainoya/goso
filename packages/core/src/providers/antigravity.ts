import type { ProviderSnapshot, UsageWindow } from "../types.ts";
import { applyLimit, type GosoConfig } from "../config.ts";
import { readCache, writeCache } from "../cache.ts";
import { DAY_MS, HOUR_MS, exists, findFiles, home, parseDuration, readVarint } from "../util.ts";

/**
 * Antigravity stores each conversation as a SQLite file of protobuf-encoded
 * steps. There is no quota record on disk, but two things are recoverable:
 * every step carries a timestamp, and steps of type 15 are model generations —
 * which is the unit Antigravity meters. Quota-exhaustion errors additionally
 * carry a "Resets in 4h19m9s" string we can turn into a reset time.
 */
const STEP_MODEL_GENERATION = 15;
const STEP_USER_PROMPT = 14;
/** Error-ish step types; these are few per conversation and cheap to scan. */
const STEP_ERROR_TYPES = [17, 23];

const ROOTS = [
  home(".gemini", "antigravity", "conversations"),
  home(".gemini", "antigravity-cli", "conversations"),
];

const RESETS_IN = /Resets in ([0-9hms.]+)/;

const CACHE_NAME = "antigravity-conversations.json";
const CACHE_VERSION = 1;

/** What one conversation database contributed, keyed by its path. */
interface DbScan {
  size: number;
  mtimeMs: number;
  generations: number[];
  prompts: number[];
  quota?: { observedAt: number; resetsAt: number };
}

type ConversationCache = Record<string, DbScan>;

/**
 * Decode the step's `metadata` blob, which is a protobuf message whose field 1
 * is a google.protobuf.Timestamp. Returns epoch ms.
 */
function stepTimestamp(blob: Uint8Array | null): number | undefined {
  if (!blob || blob.length === 0) return undefined;
  let i = 0;
  while (i < blob.length) {
    const [key, afterKey] = readVarint(blob, i);
    i = afterKey;
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 2) {
      const [len, afterLen] = readVarint(blob, i);
      const sub = blob.subarray(afterLen, afterLen + len);
      i = afterLen + len;
      if (field === 1 && sub.length > 0) {
        const [innerKey, afterInner] = readVarint(sub, 0);
        if (innerKey >> 3 === 1 && (innerKey & 7) === 0) {
          const [seconds] = readVarint(sub, afterInner);
          // Sanity-check: must look like a plausible epoch second.
          if (seconds > 1_000_000_000 && seconds < 4_000_000_000) return seconds * 1000;
        }
      }
    } else if (wire === 0) {
      [, i] = readVarint(blob, i);
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function findResetText(blob: Uint8Array | null): string | undefined {
  if (!blob) return undefined;
  const text = Buffer.from(blob).toString("latin1");
  const match = RESETS_IN.exec(text);
  return match?.[1];
}

interface Scan {
  generations: number[];
  prompts: number[];
  quota?: { observedAt: number; resetsAt: number };
}

type SqliteModule = typeof import("node:sqlite");

/**
 * `node:sqlite` is loaded on demand: the CLI always has it on Node 26, but
 * embedders on older runtimes should degrade to "unavailable", not crash.
 */
let sqlitePromise: Promise<SqliteModule | undefined> | undefined;
function loadSqlite(): Promise<SqliteModule | undefined> {
  sqlitePromise ??= import("node:sqlite").catch(() => undefined);
  return sqlitePromise;
}

function scanDatabase(sqlite: SqliteModule, file: string, into: { generations: number[]; prompts: number[]; quota?: { observedAt: number; resetsAt: number } }): void {
  let db: InstanceType<SqliteModule["DatabaseSync"]>;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return; // locked or not a conversation database
  }
  try {
    const steps = db
      .prepare("SELECT step_type AS t, metadata AS m FROM steps WHERE step_type IN (?, ?)")
      .all(STEP_MODEL_GENERATION, STEP_USER_PROMPT) as Array<{ t: number; m: Uint8Array | null }>;

    for (const step of steps) {
      const ts = stepTimestamp(step.m);
      if (ts === undefined) continue;
      if (step.t === STEP_MODEL_GENERATION) into.generations.push(ts);
      else into.prompts.push(ts);
    }

    const errors = db
      .prepare(
        `SELECT metadata AS m, step_payload AS p, error_details AS e
           FROM steps WHERE step_type IN (${STEP_ERROR_TYPES.map(() => "?").join(",")})`,
      )
      .all(...STEP_ERROR_TYPES) as Array<{
      m: Uint8Array | null;
      p: Uint8Array | null;
      e: Uint8Array | null;
    }>;

    for (const row of errors) {
      const text = findResetText(row.p) ?? findResetText(row.e);
      if (!text) continue;
      const duration = parseDuration(text);
      const observedAt = stepTimestamp(row.m);
      if (duration === undefined || observedAt === undefined) continue;
      if (!into.quota || observedAt > into.quota.observedAt) {
        into.quota = { observedAt, resetsAt: observedAt + duration };
      }
    }
  } catch {
    /* schema drift between Antigravity versions */
  } finally {
    db.close();
  }
}

export async function collectAntigravity(now: number, config: GosoConfig): Promise<ProviderSnapshot> {
  const base: ProviderSnapshot = { id: "antigravity", label: "Antigravity", status: "ok", windows: [] };

  const roots: string[] = [];
  for (const root of ROOTS) if (await exists(root)) roots.push(root);
  if (roots.length === 0) {
    return {
      ...base,
      status: "unavailable",
      detail: "no ~/.gemini/antigravity conversations — Antigravity not installed or never run",
    };
  }

  const weekStart = now - 7 * DAY_MS;
  const files = (
    await Promise.all(
      roots.map((root) =>
        findFiles(root, (name) => name.endsWith(".db"), { maxDepth: 2, minMtimeMs: weekStart }),
      ),
    )
  ).flat();

  if (files.length === 0) {
    return { ...base, status: "unavailable", detail: "no Antigravity activity in the last 7 days" };
  }

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return {
      ...base,
      status: "unavailable",
      detail:
        "node:sqlite is unavailable in this runtime — Antigravity's databases need Node 24+ (the goso CLI runs on Node 26 via mise)",
    };
  }

  // Conversations are rewritten rather than appended to, so an unchanged file
  // is skipped whole. Most of the week's databases are finished conversations.
  const cache = (await readCache<ConversationCache>(CACHE_NAME, CACHE_VERSION)) ?? {};
  const next: ConversationCache = {};
  const scan: Scan = { generations: [], prompts: [] };

  for (const file of files) {
    const cached = cache[file.path];
    let result: DbScan;
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      result = cached;
    } else {
      const fresh: { generations: number[]; prompts: number[]; quota?: DbScan["quota"] } = {
        generations: [],
        prompts: [],
      };
      scanDatabase(sqlite, file.path, fresh);
      result = { size: file.size, mtimeMs: file.mtimeMs, ...fresh };
    }

    // Drop steps that have aged out of the window so the cache stays bounded.
    next[file.path] = {
      ...result,
      generations: result.generations.filter((ts) => ts >= weekStart),
      prompts: result.prompts.filter((ts) => ts >= weekStart),
    };

    scan.generations.push(...next[file.path]!.generations);
    scan.prompts.push(...next[file.path]!.prompts);
    const quota = result.quota;
    if (quota && (!scan.quota || quota.observedAt > scan.quota.observedAt)) scan.quota = quota;
  }

  await writeCache(CACHE_NAME, CACHE_VERSION, next);

  if (scan.generations.length === 0 && scan.prompts.length === 0) {
    return { ...base, status: "unavailable", detail: "no timestamped Antigravity steps in the last 7 days" };
  }

  const blockStart = now - 5 * HOUR_MS;
  const inBlock = scan.generations.filter((ts) => ts >= blockStart).length;

  const exhausted = scan.quota && scan.quota.resetsAt > now ? scan.quota : undefined;

  const windows: UsageWindow[] = [
    {
      id: "5h",
      label: "last 5h",
      unit: "requests",
      ...applyLimit(inBlock, config.antigravity?.fiveHourRequests),
      windowMs: 5 * HOUR_MS,
      source: "derived",
      note: "model generations",
    },
    {
      id: "weekly",
      label: "7 days",
      unit: "requests",
      ...applyLimit(scan.generations.length, config.antigravity?.weeklyRequests),
      windowMs: 7 * DAY_MS,
      source: "derived",
      note: "rolling",
    },
  ];

  // The only quota fact Antigravity leaves on disk is the 429 it got back.
  // While that reset is still in the future the account is genuinely capped.
  if (exhausted) {
    windows.unshift({
      id: "quota",
      label: "quota",
      unit: "requests",
      usedPercent: 100,
      resetsAt: exhausted.resetsAt,
      source: "reported",
      note: "exhausted",
    });
  }

  const notes = [`${scan.prompts.length} user prompts in 7 days`];
  if (scan.quota) {
    const when = new Date(scan.quota.observedAt).toISOString();
    notes.push(
      scan.quota.resetsAt > now
        ? `quota exhausted at ${when}; server said it resets ${new Date(scan.quota.resetsAt).toISOString()}`
        : `last quota exhaustion at ${when} (already reset)`,
    );
  }
  notes.push("request counts are derived locally; Antigravity does not cache quota on disk");

  const lastActivity = Math.max(...scan.generations, ...scan.prompts, 0);

  return {
    ...base,
    windows,
    lastActivityAt: lastActivity > 0 ? lastActivity : undefined,
    notes,
  };
}
