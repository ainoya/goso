import type { ProviderSnapshot, Snapshot, UsageWindow } from "./types.ts";

export interface RankedWindow {
  provider: ProviderSnapshot;
  window: UsageWindow;
  usedPercent: number;
}

/** Every window with a known percentage, most-constrained first. */
export function rankWindows(snapshot: Snapshot): RankedWindow[] {
  return snapshot.providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) => provider.windows.map((window) => ({ provider, window })))
    .filter((entry): entry is RankedWindow & { usedPercent: number } => entry.window.usedPercent !== undefined)
    .map((entry) => ({ ...entry, usedPercent: entry.window.usedPercent! }))
    .sort((a, b) => b.usedPercent - a.usedPercent);
}

/** The soonest reset across every provider, for "what frees up next". */
export function nextReset(snapshot: Snapshot): { provider: ProviderSnapshot; window: UsageWindow } | undefined {
  return snapshot.providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) => provider.windows.map((window) => ({ provider, window })))
    .filter((entry) => entry.window.resetsAt !== undefined && entry.window.resetsAt > snapshot.generatedAt)
    .sort((a, b) => a.window.resetsAt! - b.window.resetsAt!)[0];
}

/** One-line summary: the window closest to its limit. For status bars. */
export function summarize(snapshot: Snapshot): string {
  const worst = rankWindows(snapshot)[0];
  if (!worst) return "no quota data";
  return `${worst.provider.label} ${worst.window.label} ${worst.usedPercent.toFixed(0)}%`;
}

export interface OverviewRow {
  provider: ProviderSnapshot;
  /** The window this row stands for, absent when the agent has none to show. */
  window?: UsageWindow;
}

/**
 * The one window that decides whether this agent is usable right now.
 *
 * Normally that is the shortest window it reports — the session window, which
 * is the one you actually hit mid-task. A window already at its ceiling wins
 * regardless of length, because a spent weekly quota stops you just as dead.
 */
function currentBlocker(provider: ProviderSnapshot, now: number): UsageWindow | undefined {
  const measured = provider.windows.filter((window) => window.usedPercent !== undefined);

  const exhausted = measured
    .filter((window) => window.usedPercent! >= 100 && (window.resetsAt ?? Infinity) > now)
    .sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity));
  if (exhausted[0]) return exhausted[0];

  // Windows that never said how long they are sort last rather than winning by
  // default.
  const byLength = measured.sort(
    (a, b) => (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity) || b.usedPercent! - a.usedPercent!,
  );
  if (byLength[0]) return byLength[0];

  // Nothing measured: the next reset is the most actionable thing we have.
  const soonest = provider.windows
    .filter((window) => window.resetsAt !== undefined && window.resetsAt > now)
    .sort((a, b) => a.resetsAt! - b.resetsAt!);
  return soonest[0] ?? provider.windows[0];
}

/**
 * The at-a-glance survey: one row per agent answering "can I use this right
 * now", ranked so whatever is closest to stopping you leads. Everything else —
 * longer windows, raw token and request counts — lives in the per-agent
 * sections, where there is room to read it.
 */
export function overview(snapshot: Snapshot): OverviewRow[] {
  const rows: OverviewRow[] = snapshot.providers.map((provider) =>
    provider.status === "ok" ? { provider, window: currentBlocker(provider, snapshot.generatedAt) } : { provider },
  );

  const rank = (row: OverviewRow): number => {
    if (row.provider.status !== "ok") return 3;
    if (row.window?.usedPercent !== undefined) return 0;
    return row.window ? 1 : 2;
  };

  return rows.sort((a, b) => rank(a) - rank(b) || (b.window?.usedPercent ?? -1) - (a.window?.usedPercent ?? -1));
}
