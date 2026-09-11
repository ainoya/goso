import { readFile } from "node:fs/promises";
import path from "node:path";
import { home } from "./util.ts";

/**
 * Optional user config. Vendors do not publish per-plan quotas in a
 * machine-readable form, so limits for locally-derived numbers (Claude tokens,
 * Gemini/Antigravity request counts) are opt-in: fill these in and goso will
 * show percentages and bars instead of bare counts.
 */
export interface GosoConfig {
  claude?: {
    /** Token budget for one 5-hour session block. */
    fiveHourTokens?: number;
    /** Token budget for the rolling 7-day window. */
    weeklyTokens?: number;
    /**
     * Read the OAuth token from the login keychain to fetch real percentages
     * from the API. Default true; set false to stay fully offline.
     */
    useKeychain?: boolean;
  };
  antigravity?: {
    fiveHourRequests?: number;
    weeklyRequests?: number;
  };
}

export function configPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? path.join(xdg, "goso", "config.json") : home(".config", "goso", "config.json");
}

export async function loadConfig(): Promise<GosoConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as GosoConfig;
  } catch {
    return {};
  }
}

/** Attach a percentage to a window when the user configured a limit for it. */
export function applyLimit(
  used: number | undefined,
  limit: number | undefined,
): { used?: number; limit?: number; usedPercent?: number } {
  if (used === undefined) return {};
  if (limit === undefined || limit <= 0) return { used };
  return { used, limit, usedPercent: (used / limit) * 100 };
}
