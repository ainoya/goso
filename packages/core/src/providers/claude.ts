import type { ProviderSnapshot, TokenBreakdown, UsageWindow } from "../types.ts";
import { applyLimit, type GosoConfig } from "../config.ts";
import { fetchClaudeUtilization } from "./claude-api.ts";
import { DAY_MS, HOUR_MS, exists, findFiles, floorToHour, home, parseTimestamp, readJsonl } from "../util.ts";

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

async function readEntries(since: number): Promise<Entry[]> {
  const files = await findFiles(PROJECTS, (name) => name.endsWith(".jsonl"), { minMtimeMs: since });
  const seen = new Set<string>();
  const entries: Entry[] = [];

  for (const file of files) {
    for await (const record of readJsonl(file.path)) {
      if (record["type"] !== "assistant") continue;
      const message = record["message"] as
        | { id?: string; model?: string; usage?: Record<string, unknown> }
        | undefined;
      const usage = message?.usage;
      if (!usage) continue;

      // The same assistant message can appear in several transcripts (resumes,
      // sidechains, compaction copies). Dedupe on message id + request id.
      const key = `${message?.id ?? ""}:${String(record["requestId"] ?? "")}`;
      if (key !== ":" && seen.has(key)) continue;
      if (key !== ":") seen.add(key);

      const ts = parseTimestamp(record["timestamp"]);
      if (ts === undefined || ts < since) continue;

      entries.push({
        ts,
        model: String(message?.model ?? "unknown"),
        input: Number(usage["input_tokens"] ?? 0),
        output: Number(usage["output_tokens"] ?? 0),
        cacheRead: Number(usage["cache_read_input_tokens"] ?? 0),
        cacheWrite: Number(usage["cache_creation_input_tokens"] ?? 0),
      });
    }
  }

  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

export interface Block {
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
