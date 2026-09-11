#!/usr/bin/env node
/**
 * Prints the sample output used in the README, from a fixed made-up snapshot.
 *
 * The README must never be pasted from a real run: that would publish the
 * author's plan tier, quota levels and activity times. Rendering a fixture
 * through the real renderer keeps the sample format-accurate — bar widths,
 * column padding and all — without any of that.
 *
 *   pnpm sample
 */
import type { ProviderSnapshot, Snapshot } from "../packages/core/src/index.ts";
import { formatClock, overview } from "../packages/core/src/index.ts";
import { render } from "../packages/cli/src/render.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A Saturday morning, so weekday labels in the sample are stable. */
const NOW = new Date(2026, 8, 12, 9, 30).getTime();

const providers: ProviderSnapshot[] = [
  {
    id: "claude",
    label: "Claude Code",
    status: "ok",
    plan: "claude-opus-5, claude-sonnet-5",
    lastActivityAt: NOW - 2 * 60_000,
    windows: [
      {
        id: "5h",
        label: "session limit",
        unit: "tokens",
        usedPercent: 31,
        resetsAt: NOW + 3 * HOUR + 30 * 60_000,
        windowMs: 5 * HOUR,
        source: "reported",
      },
      {
        id: "weekly",
        label: "weekly limit",
        unit: "tokens",
        usedPercent: 45,
        resetsAt: NOW + 2 * DAY + 18 * HOUR,
        windowMs: 7 * DAY,
        source: "reported",
      },
      {
        id: "weekly-fable",
        label: "weekly (Fable)",
        unit: "tokens",
        usedPercent: 62,
        resetsAt: NOW + 2 * DAY + 18 * HOUR,
        windowMs: 7 * DAY,
        scope: "Fable",
        source: "reported",
      },
      {
        id: "5h-tokens",
        label: "5h tokens",
        unit: "tokens",
        used: 12_400_000,
        windowMs: 5 * HOUR,
        source: "derived",
        note: "this session block",
      },
      {
        id: "weekly-tokens",
        label: "7d tokens",
        unit: "tokens",
        used: 148_000_000,
        windowMs: 7 * DAY,
        source: "derived",
        note: "rolling",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    status: "ok",
    plan: "pro",
    lastActivityAt: NOW - 41 * 60_000,
    windows: [
      {
        id: "5h",
        label: "5h limit",
        unit: "tokens",
        usedPercent: 18,
        resetsAt: NOW + 2 * HOUR + 15 * 60_000,
        windowMs: 5 * HOUR,
        source: "reported",
      },
      {
        id: "weekly",
        label: "weekly limit",
        unit: "tokens",
        usedPercent: 71,
        resetsAt: NOW + 3 * DAY + 22 * HOUR,
        windowMs: 7 * DAY,
        source: "reported",
      },
      {
        id: "today",
        label: "today",
        unit: "tokens",
        used: 21_800_000,
        windowMs: DAY,
        source: "derived",
        note: "sessions touched today",
      },
    ],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    status: "ok",
    lastActivityAt: NOW - DAY - 4 * HOUR,
    windows: [
      {
        id: "quota",
        label: "quota",
        unit: "requests",
        usedPercent: 100,
        resetsAt: NOW + 23 * HOUR + 53 * 60_000,
        source: "reported",
        note: "exhausted",
      },
      {
        id: "5h",
        label: "last 5h",
        unit: "requests",
        used: 0,
        windowMs: 5 * HOUR,
        source: "derived",
        note: "model generations",
      },
      {
        id: "weekly",
        label: "7 days",
        unit: "requests",
        used: 1204,
        windowMs: 7 * DAY,
        source: "derived",
        note: "rolling",
      },
    ],
  },
];

const snapshot: Snapshot = { generatedAt: NOW, providers };

const cli = render(snapshot, { color: false, verbose: false })
  .split("\n")
  .filter((line) => !line.includes("--json for machine output"))
  .join("\n")
  .replace(/\n{3,}$/, "\n");

process.stdout.write(cli);

// The Raycast Overview section, laid out the way that list reads.
process.stdout.write("\n  Overview                                     can you use it right now?\n");
for (const { provider, window } of overview(snapshot)) {
  const percent = window?.usedPercent === undefined ? "—" : `${window.usedPercent.toFixed(0)}%`;
  const reset = window?.resetsAt !== undefined && window.resetsAt > NOW ? formatClock(window.resetsAt) : "";
  process.stdout.write(
    `    ${provider.label.padEnd(13)} ${(window?.label ?? "Not available").padEnd(16)} ${reset.padEnd(23)} ${percent.padStart(4)}\n`,
  );
}
