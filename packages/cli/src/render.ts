import type { ProviderSnapshot, Snapshot, UsageWindow } from "@goso/core";
import { bar, formatClock, formatCount, formatDuration, formatReset } from "@goso/core";

interface Theme {
  dim: (s: string) => string;
  bold: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
}

const plain: Theme = {
  dim: (s) => s,
  bold: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  red: (s) => s,
  cyan: (s) => s,
};

const wrap = (code: string) => (s: string) => `\u001b[${code}m${s}\u001b[0m`;

const colored: Theme = {
  dim: wrap("2"),
  bold: wrap("1"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
  cyan: wrap("36"),
};

export function theme(useColor: boolean): Theme {
  return useColor ? colored : plain;
}

function severity(percent: number | undefined, t: Theme): (s: string) => string {
  if (percent === undefined) return t.dim;
  if (percent >= 90) return t.red;
  if (percent >= 70) return t.yellow;
  return t.green;
}

const LABEL_WIDTH = 15;

function renderWindow(window: UsageWindow, now: number, t: Theme): string {
  const label = window.label.padEnd(LABEL_WIDTH);
  const paint = severity(window.usedPercent, t);

  const gauge = window.usedPercent === undefined ? t.dim("─".repeat(20)) : paint(bar(window.usedPercent));

  const percent =
    window.usedPercent === undefined ? t.dim("  — ") : paint(`${window.usedPercent.toFixed(0).padStart(3)}%`);

  // A tilde marks a number we computed ourselves rather than one the vendor reported.
  const marker = window.source === "reported" ? " " : t.dim("~");
  const amount = window.used === undefined ? " ".repeat(10) : formatCount(window.used, window.unit).padStart(10);
  const reset = window.resetsAt === undefined ? "" : t.cyan(`resets ${formatReset(window.resetsAt, now)}`);
  const note = window.note ? t.dim(window.note) : "";

  return `    ${label} ${gauge} ${percent}${marker} ${amount}  ${reset || note}`.trimEnd();
}

function renderProvider(provider: ProviderSnapshot, now: number, t: Theme, verbose: boolean): string[] {
  const lines: string[] = [];
  const title = t.bold(provider.label.padEnd(14));

  if (provider.status !== "ok") {
    const tag = provider.status === "error" ? t.red("error") : t.dim("unavailable");
    lines.push(`  ${title} ${tag}`);
    if (provider.detail) lines.push(`    ${t.dim(provider.detail)}`);
    return lines;
  }

  const meta = [
    provider.plan,
    provider.lastActivityAt ? `last used ${formatDuration(now - provider.lastActivityAt)} ago` : undefined,
  ]
    .filter(Boolean)
    .join("  ·  ");
  lines.push(`  ${title} ${t.dim(meta)}`.trimEnd());

  for (const window of provider.windows) lines.push(renderWindow(window, now, t));
  if (verbose) for (const note of provider.notes ?? []) lines.push(`    ${t.dim(`• ${note}`)}`);
  return lines;
}

export function render(snapshot: Snapshot, opts: { color: boolean; verbose: boolean }): string {
  const t = theme(opts.color);
  const now = snapshot.generatedAt;
  const stamp = formatClock(now);

  const lines: string[] = ["", `  ${t.bold("goso")} ${t.dim(`— AI agent usage · ${stamp}`)}`, ""];
  for (const provider of snapshot.providers) {
    lines.push(...renderProvider(provider, now, t, opts.verbose));
    lines.push("");
  }
  lines.push(`  ${t.dim("~ derived locally (estimate)  ·  unmarked = reported by the vendor")}`);
  if (!opts.verbose) lines.push(`  ${t.dim("-v for notes  ·  --json for machine output")}`);
  lines.push("");
  return lines.join("\n");
}
