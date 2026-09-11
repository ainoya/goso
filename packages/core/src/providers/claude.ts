import { open } from "node:fs/promises";
import type { ProviderSnapshot, TokenBreakdown, UsageWindow } from "../types.ts";
import { applyLimit, type GosoConfig } from "../config.ts";
import { readCache, writeCache } from "../cache.ts";
import { fetchClaudeUtilization } from "./claude-api.ts";
import { DAY_MS, HOUR_MS, exists, findFiles, floorToHour, home, mapConcurrent, parseTimestamp } from "../util.ts";

/**
 * Claude Code keeps no rate-limit state on disk, so usage is reconstructed
 * from the per-message `usage` blocks in its transcripts. Anthropic meters
 * subscriptions in rolling 5-hour session blocks plus a weekly window; the
 * block boundaries below reproduce that behaviour locally.
 */
const BLOCK_MS = 5 * HOUR_MS;
const PROJECTS = home(".claude", "projects");

export interface Entry {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** USD per million tokens, list API prices. */
const PRICING: Array<[RegExp, Pricing]> = [
  [/opus/, { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }],
  [/fable/, { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }],
  [/sonnet/, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  [/haiku/, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
];

function priceFor(model: string): Pricing | undefined {
  return PRICING.find(([re]) => re.test(model))?.[1];
}

function costOf(entry: Entry): number {
  const p = priceFor(entry.model);
  if (!p) return 0;
  return (
    (entry.input * p.input +
      entry.output * p.output +
      entry.cacheWrite * p.cacheWrite +
      entry.cacheRead * p.cacheRead) /
    1_000_000
  );
}

function emptyTokens(): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function accumulate(into: TokenBreakdown, entry: Entry): void {
  into.input += entry.input;
  into.output += entry.output;
  into.cacheRead += entry.cacheRead;
  into.cacheWrite += entry.cacheWrite;
  into.total += entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
}

const CACHE_NAME = "claude-transcripts.json";
const CACHE_VERSION = 1;
/** Bytes of each file's head kept to notice a file replaced rather than appended to. */
const HEAD_BYTES = 256;
/** Transcripts are I/O-bound; a small pool keeps the disk busy without thrashing. */
const READ_CONCURRENCY = 8;

/** Only lines carrying both markers can be an assistant message with usage. */
const USAGE_MARKER = Buffer.from('"usage"');
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');

/** [ts, model, input, output, cacheRead, cacheWrite, dedupe key] */
type CachedEntry = [number, string, number, number, number, number, string];

interface FileCache {
  /** Bytes consumed, always ending just past a newline so the next read starts on a line. */
  offset: number;
  /** Head of the file, to detect replacement — appends leave it untouched. */
  head: string;
  entries: CachedEntry[];
}

type TranscriptCache = Record<string, FileCache>;

function toEntry(cached: CachedEntry): Entry {
  const [ts, model, input, output, cacheRead, cacheWrite] = cached;
  return { ts, model, input, output, cacheRead, cacheWrite };
}

/**
 * Pull usage records out of a raw chunk of JSONL.
 *
 * Transcripts run to hundreds of megabytes across very long lines, and only a
 * quarter of those lines carry usage. Scanning the bytes and decoding just the
 * matching lines avoids turning the whole file into a string.
 */
export function parseChunk(buf: Buffer, base: number): { entries: CachedEntry[]; consumed: number } {
  const entries: CachedEntry[] = [];
  let start = 0;
  let consumed = 0;

  for (;;) {
    const newline = buf.indexOf(0x0a, start);
    if (newline === -1) break;
    const line = buf.subarray(start, newline);
    start = newline + 1;
    consumed = start;

    if (line.length === 0 || line[0] !== 0x7b) continue; // not a JSON object
    if (!line.includes(USAGE_MARKER) || !line.includes(ASSISTANT_MARKER)) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
    } catch {
      continue; // partially written line
    }
    if (record["type"] !== "assistant") continue;

    const message = record["message"] as
      | { id?: string; model?: string; usage?: Record<string, unknown> }
      | undefined;
    const usage = message?.usage;
    if (!usage) continue;

    const ts = parseTimestamp(record["timestamp"]);
    if (ts === undefined) continue;

    entries.push([
      ts,
      String(message?.model ?? "unknown"),
      Number(usage["input_tokens"] ?? 0),
      Number(usage["output_tokens"] ?? 0),
      Number(usage["cache_read_input_tokens"] ?? 0),
      Number(usage["cache_creation_input_tokens"] ?? 0),
      `${message?.id ?? ""}:${String(record["requestId"] ?? "")}`,
    ]);
  }

  return { entries, consumed: base + consumed };
}

/**
 * Read one transcript, reusing the cached records for the bytes already seen.
 * Transcripts are append-only, so an unchanged prefix means only the tail is new.
 */
async function readFileEntries(
  file: { path: string; size: number },
  cached: FileCache | undefined,
): Promise<FileCache> {
  const handle = await open(file.path, "r");
  try {
    const head = Buffer.allocUnsafe(Math.min(HEAD_BYTES, file.size));
    await handle.read(head, 0, head.length, 0);
    const headKey = head.toString("base64");

    const appended = cached !== undefined && cached.head === headKey && file.size >= cached.offset;
    const from = appended ? cached.offset : 0;
    const length = file.size - from;
    if (length <= 0) return { offset: from, head: headKey, entries: cached?.entries ?? [] };

    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, from);
    const { entries, consumed } = parseChunk(buf.subarray(0, bytesRead), from);

    return {
      offset: consumed,
      head: headKey,
      entries: appended ? [...cached!.entries, ...entries] : entries,
    };
  } finally {
    await handle.close();
  }
}

async function readEntries(since: number): Promise<Entry[]> {
  const files = await findFiles(PROJECTS, (name) => name.endsWith(".jsonl"), { minMtimeMs: since });
  const cache = (await readCache<TranscriptCache>(CACHE_NAME, CACHE_VERSION)) ?? {};
  const next: TranscriptCache = {};

  const results = await mapConcurrent(files, READ_CONCURRENCY, async (file) => {
    try {
      return { path: file.path, cache: await readFileEntries(file, cache[file.path]) };
    } catch {
      return undefined; // vanished or unreadable mid-run
    }
  });

  const seen = new Set<string>();
  const entries: Entry[] = [];

  for (const result of results) {
    if (!result) continue;
    // Drop records that have aged out of the window so the cache stays bounded.
    const fresh = result.cache.entries.filter((entry) => entry[0] >= since);
    next[result.path] = { ...result.cache, entries: fresh };

    for (const cached of fresh) {
      // The same assistant message can appear in several transcripts (resumes,
      // sidechains, compaction copies). Dedupe on message id + request id.
      const key = cached[6];
      if (key !== ":" && seen.has(key)) continue;
      if (key !== ":") seen.add(key);
      entries.push(toEntry(cached));
    }
  }

  await writeCache(CACHE_NAME, CACHE_VERSION, next);

  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

interface Block {
  startsAt: number;
  entries: Entry[];
}

/**
 * Group entries into 5-hour blocks the way Anthropic's session windows behave:
 * a block opens on the hour of its first message and closes 5 hours later, and
 * a gap of 5 hours or more with no traffic also starts a fresh block.
 */
export function toBlocks(entries: Entry[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let lastTs = 0;

  for (const entry of entries) {
    const startsNew =
      current === undefined ||
      entry.ts - current.startsAt >= BLOCK_MS ||
      entry.ts - lastTs >= BLOCK_MS;
    if (startsNew) {
      current = { startsAt: floorToHour(entry.ts), entries: [] };
      blocks.push(current);
    }
    current!.entries.push(entry);
    lastTs = entry.ts;
  }
  return blocks;
}

export async function collectClaude(
  now: number,
  config: GosoConfig,
  options: { offline?: boolean } = {},
): Promise<ProviderSnapshot> {
  const base: ProviderSnapshot = { id: "claude", label: "Claude Code", status: "ok", windows: [] };

  if (!(await exists(PROJECTS))) {
    return {
      ...base,
      status: "unavailable",
      detail: "no ~/.claude/projects directory — Claude Code not installed or never run",
    };
  }

  const weekStart = now - 7 * DAY_MS;
  const entries = await readEntries(weekStart);
  if (entries.length === 0) {
    return { ...base, status: "unavailable", detail: "no Claude Code activity in the last 7 days" };
  }

  const blocks = toBlocks(entries);
  const last = blocks[blocks.length - 1]!;
  const active = now < last.startsAt + BLOCK_MS;

  const blockTokens = emptyTokens();
  let blockCost = 0;
  if (active) {
    for (const entry of last.entries) {
      accumulate(blockTokens, entry);
      blockCost += costOf(entry);
    }
  }

  const weekTokens = emptyTokens();
  let weekCost = 0;
  for (const entry of entries) {
    accumulate(weekTokens, entry);
    weekCost += costOf(entry);
  }

  const models = [...new Set(entries.slice(-200).map((e) => e.model))].filter((m) => m !== "unknown");

  // Ask the API for the real percentages first; fall back to local estimates.
  const live =
    options.offline || config.claude?.useKeychain === false
      ? { ok: false as const, reason: options.offline ? "offline mode" : "disabled in config" }
      : await fetchClaudeUtilization(now);

  const windows: UsageWindow[] = live.ok
    ? live.value.windows.map((window) => ({
        id: window.key,
        label: window.label,
        unit: "tokens" as const,
        usedPercent: window.utilization,
        resetsAt: window.resetsAt,
        scope: window.scope,
        windowMs: window.windowMs,
        source: "reported" as const,
      }))
    : [
        {
          id: "5h",
          label: "5h session",
          unit: "tokens",
          ...applyLimit(active ? blockTokens.total : 0, config.claude?.fiveHourTokens),
          resetsAt: active ? last.startsAt + BLOCK_MS : undefined,
          windowMs: BLOCK_MS,
          source: "derived",
          note: active ? undefined : "no session block open",
        },
        {
          id: "weekly",
          label: "7 days",
          unit: "tokens",
          ...applyLimit(weekTokens.total, config.claude?.weeklyTokens),
          windowMs: 7 * DAY_MS,
          source: "derived",
          note: "rolling",
        },
      ];

  // Token totals are exact either way, so keep them alongside the percentages.
  if (live.ok) {
    windows.push(
      {
        id: "5h-tokens",
        label: "5h tokens",
        unit: "tokens",
        used: active ? blockTokens.total : 0,
        windowMs: BLOCK_MS,
        source: "derived",
        note: active ? "this session block" : "no session block open",
      },
      {
        id: "weekly-tokens",
        label: "7d tokens",
        unit: "tokens",
        used: weekTokens.total,
        windowMs: 7 * DAY_MS,
        source: "derived",
        note: "rolling",
      },
    );
  }

  const notes = [`est. cost — 5h $${blockCost.toFixed(2)} / 7d $${weekCost.toFixed(2)} at list API prices`];
  if (live.ok) {
    notes.unshift("percentages from GET /api/oauth/usage, the same source as Claude Code's /usage");
  } else {
    notes.unshift(`no live quota (${live.reason}); windows reconstructed from local transcripts`);
    if (!config.claude?.fiveHourTokens && !config.claude?.weeklyTokens) {
      notes.push("set claude.fiveHourTokens / claude.weeklyTokens in the config to see percentages");
    }
  }

  return {
    ...base,
    plan: [live.ok ? live.value.subscriptionType : undefined, models.join(", ") || undefined]
      .filter(Boolean)
      .join("  ·  "),
    windows,
    tokens: active ? blockTokens : weekTokens,
    costUsd: active ? blockCost : weekCost,
    lastActivityAt: entries[entries.length - 1]!.ts,
    notes,
  };
}
