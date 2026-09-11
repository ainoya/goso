import assert from "node:assert/strict";
import test from "node:test";
import { overview, rankWindows, summarize } from "../src/summary.ts";
import type { ProviderSnapshot, Snapshot } from "../src/types.ts";

const now = Date.parse("2026-09-11T10:00:00.000Z");
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function provider(over: Partial<ProviderSnapshot> & Pick<ProviderSnapshot, "id" | "label">): ProviderSnapshot {
  return { status: "ok", windows: [], ...over };
}

const snapshot: Snapshot = {
  generatedAt: now,
  providers: [
    provider({
      id: "claude",
      label: "Claude Code",
      windows: [
        { id: "5h", label: "session limit", unit: "tokens", usedPercent: 13, windowMs: FIVE_HOURS, source: "reported" },
        { id: "weekly", label: "weekly limit", unit: "tokens", usedPercent: 58, windowMs: SEVEN_DAYS, source: "reported" },
        {
          id: "weekly-fable",
          label: "weekly (Fable)",
          unit: "tokens",
          usedPercent: 70,
          scope: "Fable",
          windowMs: SEVEN_DAYS,
          source: "reported",
        },
      ],
    }),
    provider({
      id: "codex",
      label: "Codex",
      windows: [
        { id: "5h", label: "5h limit", unit: "tokens", usedPercent: 7, windowMs: FIVE_HOURS, source: "reported" },
        { id: "weekly", label: "weekly limit", unit: "tokens", usedPercent: 84, windowMs: SEVEN_DAYS, source: "reported" },
        // Derived counts carry no percentage, so they stay out of the overview.
        { id: "today", label: "today", unit: "tokens", used: 42_000_000, source: "derived" },
      ],
    }),
    provider({
      id: "antigravity",
      label: "Antigravity",
      windows: [
        { id: "5h", label: "last 5h", unit: "requests", used: 4, source: "derived" },
        { id: "weekly", label: "7 days", unit: "requests", used: 40, resetsAt: now + 3600_000, source: "derived" },
      ],
    }),
  ],
};

test("overview gives each agent one row: the window that stops it soonest", () => {
  assert.deepEqual(
    overview(snapshot).map((row) => [row.provider.label, row.window?.label, row.window?.usedPercent]),
    [
      // The session window wins over fuller weekly ones: it is what you hit
      // mid-task, and it is the question the overview asks.
      ["Claude Code", "session limit", 13],
      ["Codex", "5h limit", 7],
      // No percentage available, so the soonest reset is surfaced instead.
      ["Antigravity", "7 days", undefined],
    ],
  );
});

test("a window already at its ceiling outranks the session window", () => {
  const blocked: Snapshot = {
    generatedAt: now,
    providers: [
      provider({
        id: "antigravity",
        label: "Antigravity",
        windows: [
          { id: "5h", label: "last 5h", unit: "requests", usedPercent: 0, windowMs: FIVE_HOURS, source: "derived" },
          { id: "quota", label: "quota", unit: "requests", usedPercent: 100, resetsAt: now + 3600_000, source: "reported" },
        ],
      }),
    ],
  };
  assert.equal(overview(blocked)[0]?.window?.label, "quota");
});

test("a spent window that has already reset does not outrank anything", () => {
  const stale: Snapshot = {
    generatedAt: now,
    providers: [
      provider({
        id: "antigravity",
        label: "Antigravity",
        windows: [
          { id: "5h", label: "last 5h", unit: "requests", usedPercent: 0, windowMs: FIVE_HOURS, source: "derived" },
          { id: "quota", label: "quota", unit: "requests", usedPercent: 100, resetsAt: now - 1, source: "reported" },
        ],
      }),
    ],
  };
  assert.equal(overview(stale)[0]?.window?.label, "last 5h");
});

test("a window that never said how long it is loses to one that did", () => {
  const mixed: Snapshot = {
    generatedAt: now,
    providers: [
      provider({
        id: "codex",
        label: "Codex",
        windows: [
          { id: "mystery", label: "mystery", unit: "tokens", usedPercent: 90, source: "reported" },
          { id: "5h", label: "5h limit", unit: "tokens", usedPercent: 3, windowMs: FIVE_HOURS, source: "reported" },
        ],
      }),
    ],
  };
  assert.equal(overview(mixed)[0]?.window?.label, "5h limit");
});

test("rankWindows and summarize agree on the tightest window overall", () => {
  assert.equal(rankWindows(snapshot)[0]?.usedPercent, 84);
  assert.equal(summarize(snapshot), "Codex weekly limit 84%");
});

