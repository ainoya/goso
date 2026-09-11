import assert from "node:assert/strict";
import test from "node:test";
import { parseChunk } from "../src/providers/claude.ts";

const ts = "2026-09-11T10:00:00.000Z";

function line(over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: { input_tokens: 2, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
    },
    ...over,
  })}\n`;
}

test("pulls token counts out of an assistant line", () => {
  const { entries } = parseChunk(Buffer.from(line()), 0);
  assert.deepEqual(entries, [[Date.parse(ts), "claude-opus-5", 2, 30, 400, 50, "msg_1:req_1"]]);
});

test("skips lines that are not assistant messages with usage", () => {
  const chunk = [
    JSON.stringify({ type: "user", timestamp: ts, message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "m", model: "x" } }),
    '{"type":"assistant","malformed',
    "",
    "not json at all",
  ].join("\n");
  assert.deepEqual(parseChunk(Buffer.from(`${chunk}\n`), 0).entries, []);
});

test("consumed stops at the last newline, so a half-written line is re-read", () => {
  const complete = line();
  const partial = '{"type":"assistant","timestamp":"2026-09-11T10:01';
  const { entries, consumed } = parseChunk(Buffer.from(complete + partial), 0);
  assert.equal(entries.length, 1);
  assert.equal(consumed, Buffer.byteLength(complete));
});

test("consumed is absolute, so the next read resumes where this one stopped", () => {
  const chunk = line();
  const { consumed } = parseChunk(Buffer.from(chunk), 5000);
  assert.equal(consumed, 5000 + Buffer.byteLength(chunk));
});

test("a chunk with no newline consumes nothing", () => {
  const { entries, consumed } = parseChunk(Buffer.from('{"type":"assis'), 128);
  assert.deepEqual(entries, []);
  assert.equal(consumed, 128);
});

test("reading a file in two chunks yields the same entries as one pass", () => {
  const whole = line() + line({ requestId: "req_2", timestamp: "2026-09-11T10:05:00.000Z" });
  const cut = Buffer.byteLength(line()) + 20; // mid-way through the second line

  const onePass = parseChunk(Buffer.from(whole), 0);
  const first = parseChunk(Buffer.from(whole).subarray(0, cut), 0);
  const second = parseChunk(Buffer.from(whole).subarray(first.consumed), first.consumed);

  assert.deepEqual([...first.entries, ...second.entries], onePass.entries);
  assert.equal(second.consumed, onePass.consumed);
});
