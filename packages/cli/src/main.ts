#!/usr/bin/env node
import { parseArgs } from "node:util";
import { collect, configPath, PROVIDER_IDS, summarize, type ProviderId } from "@goso/core";
import { render } from "./render.ts";

const HELP = `goso — token usage, consumption and next reset across your AI agents

Usage
  goso [options]

Options
  -j, --json          Print the raw snapshot as JSON
  -1, --oneline       Print a single line (the window closest to its limit)
  -o, --only <ids>    Comma-separated subset: ${PROVIDER_IDS.join(",")}
  -w, --watch [sec]   Redraw every <sec> seconds (default 60)
  -v, --verbose       Show per-provider notes
      --offline       Skip network calls (no live Claude Code percentages)
      --no-color      Disable ANSI colour
  -h, --help          Show this help

Config
  ${configPath()}
  Optional. Claude Code percentages come from the API by default; these limits
  are the fallback when that is unavailable, and cover the other agents:
  { "claude": { "fiveHourTokens": 88000000, "weeklyTokens": 440000000 },
    "antigravity": { "fiveHourRequests": 100, "weeklyRequests": 1000 } }
`;

function parseOnly(value: string | undefined): ProviderId[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !PROVIDER_IDS.includes(id as ProviderId));
  if (unknown.length > 0) {
    throw new Error(`unknown provider(s): ${unknown.join(", ")} (known: ${PROVIDER_IDS.join(", ")})`);
  }
  return ids as ProviderId[];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", short: "j", default: false },
      oneline: { type: "boolean", short: "1", default: false },
      only: { type: "string", short: "o" },
      watch: { type: "string", short: "w" },
      verbose: { type: "boolean", short: "v", default: false },
      offline: { type: "boolean", default: false },
      color: { type: "boolean", default: true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowNegative: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const only = parseOnly(values.only);
  const useColor = values.color !== false && process.stdout.isTTY === true && !process.env["NO_COLOR"];

  const draw = async (): Promise<void> => {
    const snapshot = await collect({ only, offline: values.offline === true });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else if (values.oneline) {
      process.stdout.write(`${summarize(snapshot)}\n`);
    } else {
      process.stdout.write(render(snapshot, { color: useColor, verbose: values.verbose === true }));
    }
  };

  if (values.watch === undefined) {
    await draw();
    return 0;
  }

  const seconds = values.watch === "" ? 60 : Number(values.watch);
  if (!Number.isFinite(seconds) || seconds < 1) throw new Error(`--watch expects seconds, got "${values.watch}"`);

  // Alternate screen buffer, restored on exit so the shell scrollback survives.
  const enter = "\u001b[?1049h";
  const leave = "\u001b[?1049l";
  process.stdout.write(enter);
  const restore = () => {
    process.stdout.write(leave);
    process.exit(0);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);

  for (;;) {
    process.stdout.write("\u001b[H\u001b[2J");
    await draw();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

try {
  process.exit(await main());
} catch (error) {
  process.stderr.write(`goso: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
