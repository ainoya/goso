import assert from "node:assert/strict";
import test from "node:test";
import { floorToHour, parseDuration, parseTimestamp, readVarint } from "../src/util.ts";

test("parseDuration understands the shapes Antigravity emits", () => {
  assert.equal(parseDuration("4h19m9s"), (4 * 3600 + 19 * 60 + 9) * 1000);
  assert.equal(parseDuration("112h10m50s"), (112 * 3600 + 10 * 60 + 50) * 1000);
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("2m"), 120_000);
  assert.equal(parseDuration("nonsense"), undefined);
});

test("readVarint decodes multi-byte protobuf varints", () => {
  // The epoch-second field of a real Antigravity step timestamp.
  const buf = Uint8Array.from([0xec, 0xe3, 0xf9, 0xd4, 0x06]);
  assert.deepEqual(readVarint(buf, 0), [1_788_768_748, 5]);
  assert.deepEqual(readVarint(Uint8Array.from([0x05]), 0), [5, 1]);
});

test("parseTimestamp accepts ISO strings and epoch seconds", () => {
  assert.equal(parseTimestamp("2026-09-11T00:07:59.819Z"), Date.parse("2026-09-11T00:07:59.819Z"));
  assert.equal(parseTimestamp(1_789_100_422), 1_789_100_422_000);
  assert.equal(parseTimestamp(1_789_100_422_000), 1_789_100_422_000);
  assert.equal(parseTimestamp(undefined), undefined);
});

test("floorToHour truncates to the hour", () => {
  const t = Date.parse("2026-09-11T10:36:12.500Z");
  assert.equal(floorToHour(t), Date.parse("2026-09-11T10:00:00.000Z"));
});
