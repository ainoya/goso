import type { ProviderSnapshot, TokenBreakdown, UsageWindow } from "../types.ts";
import { DAY_MS, exists, findFiles, home, readTail, parseTimestamp } from "../util.ts";

/**
 * Codex writes the server's own rate-limit state into every `token_count`
 * event of its session rollout logs, so its numbers are authoritative rather
 * than derived.
 */
interface CodexRateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexRateLimits {
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  plan_type?: string | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string } | null;
  rate_limit_reached_type?: string | null;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface TokenCountPayload {
  type?: string;
  info?: { total_token_usage?: CodexTokenUsage } | null;
  rate_limits?: CodexRateLimits | null;
}

const SESSION_ROOTS = [home(".codex", "sessions"), home(".codex", "archived_sessions")];
/** Only the tail of a rollout carries the latest totals; cap the read. */
const TAIL_BYTES = 512 * 1024;
/** How many recent sessions to scan for token totals. */
const MAX_SESSIONS = 40;

function windowLabel(minutes: number | undefined): { id: string; label: string } {
  if (minutes === undefined) return { id: "window", label: "window" };
  if (minutes <= 60) return { id: `${minutes}m`, label: `${minutes}m limit` };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { id: `${hours}h`, label: `${hours}h limit` };
  const days = Math.round(hours / 24);
  return { id: days === 7 ? "weekly" : `${days}d`, label: days === 7 ? "weekly limit" : `${days}d limit` };
}

function toWindow(raw: CodexRateWindow | null | undefined): UsageWindow | undefined {
  if (!raw || raw.used_percent === undefined) return undefined;
  const { id, label } = windowLabel(raw.window_minutes);
  return {
    id,
    label,
    unit: "tokens",
    usedPercent: raw.used_percent,
    resetsAt: raw.resets_at === undefined ? undefined : raw.resets_at * 1000,
    windowMs: raw.window_minutes === undefined ? undefined : raw.window_minutes * 60_000,
    source: "reported",
  };
}

/** Last `token_count` payload in a rollout file, read from its tail. */
async function lastTokenCount(file: string): Promise<{ payload: TokenCountPayload; ts?: number } | undefined> {
  let text: string;
  try {
    text = await readTail(file, TAIL_BYTES);
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line) as { payload?: TokenCountPayload; timestamp?: string };
      if (event.payload?.type === "token_count") {
        return { payload: event.payload, ts: parseTimestamp(event.timestamp) };
      }
    } catch {
      /* truncated line */
    }
  }
  return undefined;
}

function addUsage(into: TokenBreakdown, usage: CodexTokenUsage): void {
  const cacheRead = usage.cached_input_tokens ?? 0;
  // Codex reports cached tokens inside input_tokens; split them out so the
  // breakdown matches how the other providers report.
  into.input += Math.max(0, (usage.input_tokens ?? 0) - cacheRead);
  into.cacheRead += cacheRead;
  into.cacheWrite += usage.cache_write_input_tokens ?? 0;
  into.output += usage.output_tokens ?? 0;
  into.total += usage.total_tokens ?? 0;
}

export async function collectCodex(now: number): Promise<ProviderSnapshot> {
  const snapshot: ProviderSnapshot = { id: "codex", label: "Codex", status: "ok", windows: [] };

  const roots: string[] = [];
  for (const root of SESSION_ROOTS) if (await exists(root)) roots.push(root);
  if (roots.length === 0) {
    return {
      ...snapshot,
      status: "unavailable",
      detail: "no ~/.codex/sessions directory — Codex CLI not installed or never run",
    };
  }

  const files = (
    await Promise.all(
      roots.map((root) =>
        findFiles(root, (name) => name.endsWith(".jsonl"), { minMtimeMs: now - 7 * DAY_MS }),
      ),
    )
  )
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSIONS);

  if (files.length === 0) {
    return { ...snapshot, status: "unavailable", detail: "no Codex sessions in the last 7 days" };
  }

  const today: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const week: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let best: { payload: TokenCountPayload; ts: number } | undefined;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);

  const results = await Promise.all(
    files.map(async (file) => ({ file, result: await lastTokenCount(file.path) })),
  );

  for (const { file, result } of results) {
    if (!result) continue;
    const ts = result.ts ?? file.mtimeMs;
    const usage = result.payload.info?.total_token_usage;
    if (usage) {
      addUsage(week, usage);
      if (ts >= dayStart) addUsage(today, usage);
    }
    if (result.payload.rate_limits && (!best || ts > best.ts)) {
      best = { payload: result.payload, ts };
    }
  }

  snapshot.lastActivityAt = files[0]?.mtimeMs;
  snapshot.tokens = today;

  const limits = best?.payload.rate_limits;
  if (!limits) {
    return {
      ...snapshot,
      status: "ok",
      notes: ["no rate-limit data in recent sessions; showing token totals only"],
      windows: [
        { id: "today", label: "today", unit: "tokens", used: today.total, windowMs: DAY_MS, source: "derived", note: "sessions touched today" },
        { id: "weekly", label: "7 days", unit: "tokens", used: week.total, windowMs: 7 * DAY_MS, source: "derived", note: "rolling" },
      ],
    };
  }

  const primary = toWindow(limits.primary);
  const secondary = toWindow(limits.secondary);
  const windows = [primary, secondary].filter((w): w is UsageWindow => w !== undefined);
  windows.push({
    id: "today",
    label: "today",
    unit: "tokens",
    used: today.total,
    windowMs: DAY_MS,
    source: "derived",
    note: "sessions touched today",
  });

  const notes: string[] = [];
  if (limits.rate_limit_reached_type) notes.push(`rate limit reached: ${limits.rate_limit_reached_type}`);
  if (limits.credits?.unlimited) notes.push("credits: unlimited");
  else if (limits.credits?.has_credits) notes.push(`credits balance: ${limits.credits.balance ?? "?"}`);
  if (best) notes.push(`rate limits observed ${new Date(best.ts).toISOString()}`);

  return {
    ...snapshot,
    plan: limits.plan_type ?? undefined,
    windows,
    notes,
  };
}
