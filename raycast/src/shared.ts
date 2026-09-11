import { Color, Icon } from "@raycast/api";
import {
  formatClock,
  formatCount,
  formatDuration,
  formatReset,
  type ProviderSnapshot,
  type Snapshot,
  type UsageWindow,
} from "@goso/core";

export { formatClock, formatCount, formatDuration, formatReset };
export { loadSnapshot, type SnapshotResult } from "./snapshot.ts";
export type { ProviderSnapshot, Snapshot, UsageWindow };

export function severityColor(percent: number | undefined): Color {
  if (percent === undefined) return Color.SecondaryText;
  if (percent >= 90) return Color.Red;
  if (percent >= 70) return Color.Orange;
  return Color.Green;
}

export function providerIcon(provider: ProviderSnapshot): { source: Icon; tintColor: Color } {
  if (provider.status === "error") return { source: Icon.ExclamationMark, tintColor: Color.Red };
  if (provider.status === "unavailable") return { source: Icon.MinusCircle, tintColor: Color.SecondaryText };
  const worst = Math.max(...provider.windows.map((w) => w.usedPercent ?? -1), -1);
  return { source: Icon.Gauge, tintColor: worst < 0 ? Color.SecondaryText : severityColor(worst) };
}

/** "84%" when a percentage is known, otherwise the raw amount. */
export function windowValue(window: UsageWindow): string {
  if (window.usedPercent !== undefined) return `${window.usedPercent.toFixed(0)}%`;
  if (window.used !== undefined) return formatCount(window.used, window.unit);
  return "—";
}

export function windowSubtitle(window: UsageWindow, now: number): string {
  const parts: string[] = [];
  if (window.usedPercent !== undefined && window.used !== undefined) {
    parts.push(formatCount(window.used, window.unit));
  }
  if (window.resetsAt !== undefined) parts.push(`resets ${formatReset(window.resetsAt, now)}`);
  else if (window.note) parts.push(window.note);
  if (window.source === "derived") parts.push("estimated locally");
  return parts.join("  ·  ");
}

/** Plain-text rendering of one snapshot, for the Copy action. */
export function toPlainText(snapshot: Snapshot): string {
  const lines: string[] = [`goso — ${formatClock(snapshot.generatedAt)}`];
  for (const provider of snapshot.providers) {
    if (provider.status !== "ok") {
      lines.push(`${provider.label}: ${provider.status}${provider.detail ? ` (${provider.detail})` : ""}`);
      continue;
    }
    lines.push(provider.label + (provider.plan ? ` [${provider.plan}]` : ""));
    for (const window of provider.windows) {
      lines.push(`  ${window.label}: ${windowValue(window)}  ${windowSubtitle(window, snapshot.generatedAt)}`);
    }
  }
  return lines.join("\n");
}
