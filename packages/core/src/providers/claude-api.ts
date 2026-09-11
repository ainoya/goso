import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { home } from "../util.ts";

const run = promisify(execFile);

/**
 * Claude Code fetches its quota from `GET /api/oauth/usage` and never writes
 * the result to disk, so the only way to show the same percentages `/usage`
 * shows is to make the same call. The OAuth token lives in the login keychain
 * under the service below (or in a credentials file on platforms without one).
 *
 * The token is read, used as a bearer header, and dropped. It is never logged,
 * cached, or included in an error message.
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = home(".claude", ".credentials.json");
const BETA_HEADER = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5000;
/** Short cache so `--watch` and the Raycast menu bar do not re-hit the API every tick. */
const CACHE_TTL_MS = 60_000;
/** Bump whenever the cached shape changes, so stale entries are ignored. */
const CACHE_VERSION = 3;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Labels for the flat top-level windows, used only when the richer `limits`
 * map is absent. These mirror what Claude Code's own /usage prints.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "Opus limit",
  seven_day_sonnet: "Sonnet limit",
  seven_day_overage_included: "Fable limit",
  overage: "usage credit limit",
};

export interface UtilizationWindow {
  key: string;
  label: string;
  /** Percent, 0-100. */
  utilization: number;
  /** Epoch ms. */
  resetsAt?: number;
  /** Model the window is limited to, for per-model weeklies. */
  scope?: string;
  /** Length of the window in ms. */
  windowMs?: number;
}

export interface Utilization {
  windows: UtilizationWindow[];
  subscriptionType?: string;
  fetchedAt: number;
  version?: number;
}

/** A failure reason safe to show the user — never carries token material. */
export type UtilizationResult = { ok: true; value: Utilization } | { ok: false; reason: string };

interface OAuthCredentials {
  accessToken?: string;
  expiresAt?: number;
}

function pickOAuth(parsed: unknown): OAuthCredentials | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const root = parsed as Record<string, unknown>;
  const scope = (root["claudeAiOauth"] ?? root) as Record<string, unknown>;
  const accessToken = scope["accessToken"];
  if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;
  const expiresAt = scope["expiresAt"];
  return { accessToken, expiresAt: typeof expiresAt === "number" ? expiresAt : undefined };
}

async function readCredentials(): Promise<OAuthCredentials | { error: string }> {
  // A credentials file takes precedence: platforms without a login keychain
  // (and some managed installs) put the token here instead.
  try {
    const fromFile = pickOAuth(JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")));
    if (fromFile) return fromFile;
  } catch {
    /* absent or unreadable; fall through to the keychain */
  }

  if (process.platform !== "darwin") {
    return { error: "no ~/.claude/.credentials.json and no macOS keychain to read" };
  }

  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      timeout: REQUEST_TIMEOUT_MS,
    });
    const fromKeychain = pickOAuth(JSON.parse(stdout.trim()));
    if (fromKeychain) return fromKeychain;
    return { error: "keychain item found but held no OAuth access token" };
  } catch {
    // Deliberately opaque: the failure could be "denied", "not found" or a
    // parse error, and the raw output may contain secret material.
    return {
      error: `could not read "${KEYCHAIN_SERVICE}" from the login keychain (denied, or not signed in)`,
    };
  }
}

function cachePath(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  return xdg ? path.join(xdg, "goso", "claude-usage.json") : home(".cache", "goso", "claude-usage.json");
}

async function readCache(now: number): Promise<Utilization | undefined> {
  try {
    const cached = JSON.parse(await readFile(cachePath(), "utf8")) as Utilization;
    if (cached.version !== CACHE_VERSION) return undefined;
    if (typeof cached.fetchedAt !== "number" || now - cached.fetchedAt > CACHE_TTL_MS) return undefined;
    return Array.isArray(cached.windows) ? cached : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(value: Utilization): Promise<void> {
  try {
    const file = cachePath();
    await mkdir(path.dirname(file), { recursive: true });
    // Only percentages and reset times are stored — never credentials.
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    /* a cache miss is never fatal */
  }
}

/** `resets_at` arrives as an ISO string; accept epoch seconds defensively too. */
function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The `limits` map is what /usage renders: one entry per active window, with
 * `kind` naming it and `scope.model` naming the model for per-model weeklies.
 */
function parseLimits(payload: Record<string, unknown>): UtilizationWindow[] {
  const limits = payload["limits"];
  if (typeof limits !== "object" || limits === null) return [];

  const windows: UtilizationWindow[] = [];
  for (const raw of Object.values(limits as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const percent = entry["percent"];
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;

    const kind = typeof entry["kind"] === "string" ? (entry["kind"] as string) : "limit";
    const scope = entry["scope"] as { model?: { display_name?: unknown } } | null | undefined;
    const model = typeof scope?.model?.display_name === "string" ? scope.model.display_name : undefined;

    let key: string;
    let label: string;
    let windowMs: number | undefined;
    if (kind === "session") {
      key = "5h";
      label = "session limit";
      windowMs = FIVE_HOURS_MS;
    } else if (kind === "weekly_all") {
      key = "weekly";
      label = "weekly limit";
      windowMs = SEVEN_DAYS_MS;
    } else if (kind === "weekly_scoped" && model) {
      key = `weekly-${model.toLowerCase().replace(/\s+/g, "-")}`;
      label = `weekly (${model})`;
      windowMs = SEVEN_DAYS_MS;
    } else {
      key = kind;
      label = kind.replace(/_/g, " ");
    }

    windows.push({
      key,
      label,
      utilization: percent,
      resetsAt: parseResetsAt(entry["resets_at"]),
      scope: model,
      windowMs,
    });
  }
  return windows;
}

/**
 * Older/rolled-back responses expose windows as top-level keys instead. Most
 * are null placeholders for limits the account does not have, and unreleased
 * ones appear under codenames — so unnamed windows are kept only once they
 * actually carry usage.
 */
function parseFlatWindows(payload: Record<string, unknown>): UtilizationWindow[] {
  const windows: UtilizationWindow[] = [];

  for (const [key, raw] of Object.entries(payload)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const utilization = entry["utilization"];
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    const label = WINDOW_LABELS[key];
    if (label === undefined && utilization <= 0) continue;
    windows.push({
      key,
      label: label ?? key.replace(/_/g, " "),
      utilization,
      resetsAt: parseResetsAt(entry["resets_at"]),
      windowMs: key === "five_hour" ? FIVE_HOURS_MS : key.startsWith("seven_day") ? SEVEN_DAYS_MS : undefined,
    });
  }

  const order = Object.keys(WINDOW_LABELS);
  windows.sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });
  return windows;
}

export function parseWindows(payload: unknown): UtilizationWindow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;
  const fromLimits = parseLimits(root);
  return fromLimits.length > 0 ? fromLimits : parseFlatWindows(root);
}

export async function fetchClaudeUtilization(now: number): Promise<UtilizationResult> {
  const cached = await readCache(now);
  if (cached) return { ok: true, value: cached };

  const credentials = await readCredentials();
  if ("error" in credentials) return { ok: false, reason: credentials.error };
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now) {
    return { ok: false, reason: "OAuth token expired — start Claude Code once to refresh it" };
  }

  const base = process.env["ANTHROPIC_BASE_URL"]?.replace(/\/$/, "") ?? "https://api.anthropic.com";

  let response: Response;
  try {
    response = await fetch(`${base}/api/oauth/usage`, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": BETA_HEADER,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `usage request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: `usage request rejected (${response.status}) — start Claude Code once to refresh auth` };
  }
  if (!response.ok) return { ok: false, reason: `usage request returned HTTP ${response.status}` };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "usage response was not JSON" };
  }

  const windows = parseWindows(payload);
  if (windows.length === 0) return { ok: false, reason: "usage response carried no utilization windows" };

  const subscriptionType = (payload as Record<string, unknown>)["subscription_type"];
  const value: Utilization = {
    windows,
    subscriptionType: typeof subscriptionType === "string" ? subscriptionType : undefined,
    fetchedAt: now,
    version: CACHE_VERSION,
  };
  await writeCache(value);
  return { ok: true, value };
}
