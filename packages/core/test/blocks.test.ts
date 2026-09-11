import assert from "node:assert/strict";
import test from "node:test";
import { toBlocks, type Entry } from "../src/providers/claude.ts";

const HOUR = 60 * 60 * 1000;
const base = Date.parse("2026-09-11T10:36:00.000Z");

function entry(offsetMs: number): Entry {
  return { ts: base + offsetMs, model: "claude-opus-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
}

test("a block opens on the hour of its first message", () => {
  const [block] = toBlocks([entry(0), entry(30 * 60 * 1000)]);
  assert.equal(block?.startsAt, Date.parse("2026-09-11T10:00:00.000Z"));
  assert.equal(block?.entries.length, 2);
});

test("a block closes 5 hours after it opened", () => {
  // 10:00 block covers up to 15:00; a message at 15:10 starts the next one.
  const blocks = toBlocks([entry(0), entry(4 * HOUR), entry(4 * HOUR + 34 * 60 * 1000)]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.entries.length, 2);
  assert.equal(blocks[1]?.startsAt, Date.parse("2026-09-11T15:00:00.000Z"));
});

test("a 5-hour gap starts a fresh block even inside the window", () => {
  const blocks = toBlocks([entry(0), entry(5 * HOUR + 60_000)]);
  assert.equal(blocks.length, 2);
});

test("no entries means no blocks", () => {
  assert.deepEqual(toBlocks([]), []);
});
