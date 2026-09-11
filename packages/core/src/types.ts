/** Which agent a snapshot belongs to. */
export type ProviderId = "claude" | "codex" | "antigravity";

/** What a window's `used` number counts. */
export type Unit = "tokens" | "requests";

/**
 * Where a number came from. `reported` means the vendor itself told us
 * (e.g. Codex writes server rate-limit state into its session log);
 * `derived` means we computed it from local activity and it is an estimate.
 */
export type Source = "reported" | "derived";

export interface UsageWindow {
  /** Stable key: "5h", "weekly", "today", ... */
  id: string;
  label: string;
  unit: Unit;
  used?: number;
  limit?: number;
  /** 0-100. Present when the vendor reports it, or when a limit is configured. */
  usedPercent?: number;
  /** Epoch ms at which this window rolls over. */
  resetsAt?: number;
  /** Model this window is limited to. Absent for account-wide windows. */
  scope?: string;
  /** Length of the window in ms, so short session windows sort ahead of long ones. */
  windowMs?: number;
  source: Source;
  note?: string;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type ProviderStatus = "ok" | "unavailable" | "error";

export interface ProviderSnapshot {
  id: ProviderId;
  label: string;
  status: ProviderStatus;
  /** Why the provider is unavailable, or what went wrong. */
  detail?: string;
  plan?: string;
  windows: UsageWindow[];
  /** Token breakdown for the provider's primary window, when tokens are known. */
  tokens?: TokenBreakdown;
  /** Estimated USD for `tokens` at list API prices. Subscriptions are not billed this way. */
  costUsd?: number;
  lastActivityAt?: number;
  notes?: string[];
}

export interface Snapshot {
  generatedAt: number;
  providers: ProviderSnapshot[];
}

export interface CollectOptions {
  now?: number;
  only?: ProviderId[];
  /** Skip every network call, so the run touches only local files. */
  offline?: boolean;
}
