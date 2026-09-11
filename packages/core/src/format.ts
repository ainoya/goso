/** Shared number/time formatting, used by both the CLI and the Raycast UI. */

export function formatCount(value: number, unit: "tokens" | "requests"): string {
  if (unit === "requests") return `${value.toLocaleString("en-US")} req`;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B tok`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok`;
  return `${value} tok`;
}

/** "2h51m" / "3d22h" / "45s" */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Local wall-clock time as "2026/09/12 13:00(Wed)". Built by hand rather than
 * via toLocaleString: the layout is fixed-width so columns line up, and 24-hour
 * time reads unambiguously at a glance.
 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}(${WEEKDAYS[d.getDay()]})`;
}

/**
 * "2026/09/12 13:00(Wed) · in 4d2h" — the absolute time leads, because knowing
 * which day and hour a window frees up is what you plan around; the countdown
 * follows for windows about to turn over.
 */
export function formatReset(resetsAt: number, now: number): string {
  return `${formatClock(resetsAt)} · in ${formatDuration(resetsAt - now)}`;
}

export function bar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
