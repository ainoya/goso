import assert from "node:assert/strict";
import test from "node:test";
import { bar, formatClock, formatCount, formatDuration, formatReset } from "../src/format.ts";

test("formatCount scales tokens and leaves requests exact", () => {
  assert.equal(formatCount(950, "tokens"), "950 tok");
  assert.equal(formatCount(6_100_000, "tokens"), "6.1M tok");
  assert.equal(formatCount(343_600_000, "tokens"), "343.6M tok");
  assert.equal(formatCount(2_500_000_000, "tokens"), "2.50B tok");
  assert.equal(formatCount(9859, "requests"), "9,859 req");
});

test("formatDuration keeps two units at most", () => {
  assert.equal(formatDuration(0), "now");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90 * 60_000), "1h30m");
  assert.equal(formatDuration(4.1 * 24 * 3_600_000), "4d2h");
});

test("bar clamps out-of-range percentages", () => {
  assert.equal(bar(0, 4), "░░░░");
  assert.equal(bar(100, 4), "████");
  assert.equal(bar(150, 4), "████");
  assert.equal(bar(-10, 4), "░░░░");
});

test("formatClock renders YYYY/MM/DD HH:mm(Ddd) in local time", () => {
  // Built from local-time parts so the assertion holds in any timezone.
  const d = new Date(2026, 8, 12, 13, 5);
  assert.equal(formatClock(d.getTime()), "2026/09/12 13:05(Sat)");

  const midnight = new Date(2026, 0, 4, 0, 0);
  assert.equal(formatClock(midnight.getTime()), "2026/01/04 00:00(Sun)");
});

test("formatReset leads with the wall-clock time, countdown second", () => {
  const now = new Date(2026, 8, 11, 10, 0).getTime();
  assert.equal(formatReset(now + 2 * 3_600_000 + 27 * 60_000, now), "2026/09/11 12:27(Fri) · in 2h27m");
});
