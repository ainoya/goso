import assert from "node:assert/strict";
import test from "node:test";
import { parseWindows } from "../src/providers/claude-api.ts";

/** Trimmed copy of a real GET /api/oauth/usage response. */
const response = {
  five_hour: { utilization: 13, resets_at: "2026-09-11T02:00:00.133754+00:00" },
  seven_day: { utilization: 58, resets_at: "2026-09-12T19:00:00.133772+00:00" },
  seven_day_opus: null,
  nimbus_quill: { utilization: 0, resets_at: null },
  limits: {
    "0": { kind: "session", group: "session", percent: 13, resets_at: "2026-09-11T02:00:00.634483+00:00", scope: null },
    "1": { kind: "weekly_all", group: "weekly", percent: 58, resets_at: "2026-09-12T19:00:00.634509+00:00", scope: null },
    "2": {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 70,
      resets_at: "2026-09-12T18:59:59.634740+00:00",
      scope: { model: { id: null, display_name: "Fable" } },
    },
  },
};

test("the limits map wins, and names the per-model window", () => {
  const windows = parseWindows(response);
  assert.deepEqual(
    windows.map((w) => [w.key, w.label, w.utilization]),
    [
      ["5h", "session limit", 13],
      ["weekly", "weekly limit", 58],
      ["weekly-fable", "weekly (Fable)", 70],
    ],
  );
});

test("resets_at is parsed from ISO into epoch ms", () => {
  const [session] = parseWindows(response);
  assert.equal(session?.resetsAt, Date.parse("2026-09-11T02:00:00.634483+00:00"));
});

test("without a limits map, flat windows are used and null entries skipped", () => {
  const { limits, ...flat } = response;
  void limits;
  const windows = parseWindows(flat);
  assert.deepEqual(
    windows.map((w) => w.key),
    ["five_hour", "seven_day"],
  );
  assert.equal(windows[0]?.resetsAt, Date.parse("2026-09-11T02:00:00.133754+00:00"));
});

test("unreleased codename windows are hidden until they carry usage", () => {
  const quiet = parseWindows({ nimbus_quill: { utilization: 0, resets_at: null } });
  assert.deepEqual(quiet, []);

  const active = parseWindows({ nimbus_quill: { utilization: 5, resets_at: null } });
  assert.deepEqual(
    active.map((w) => [w.label, w.utilization]),
    [["nimbus quill", 5]],
  );
});

test("a malformed payload yields no windows rather than throwing", () => {
  assert.deepEqual(parseWindows(null), []);
  assert.deepEqual(parseWindows("nope"), []);
  assert.deepEqual(parseWindows({ limits: { "0": { kind: "session", percent: "13" } } }), []);
});
