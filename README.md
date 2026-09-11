# goso

One view of how much of your AI coding budget is left.

`goso` reads what **Claude Code**, **Codex** and **Antigravity** leave on disk and
prints token usage, consumption and the next quota reset side by side — in the
terminal, or in Raycast.

```
  goso — AI agent usage · 2026/09/12 09:30(Sat)

  Claude Code    claude-opus-5, claude-sonnet-5  ·  last used 2m ago
    session limit   ██████░░░░░░░░░░░░░░  31%              resets 2026/09/12 13:00(Sat) · in 3h30m
    weekly limit    █████████░░░░░░░░░░░  45%              resets 2026/09/15 03:30(Tue) · in 2d18h
    weekly (Fable)  ████████████░░░░░░░░  62%              resets 2026/09/15 03:30(Tue) · in 2d18h
    5h tokens       ────────────────────   — ~  12.4M tok  this session block
    7d tokens       ────────────────────   — ~ 148.0M tok  rolling

  Codex          pro  ·  last used 41m ago
    5h limit        ████░░░░░░░░░░░░░░░░  18%              resets 2026/09/12 11:45(Sat) · in 2h15m
    weekly limit    ██████████████░░░░░░  71%              resets 2026/09/16 07:30(Wed) · in 3d22h
    today           ────────────────────   — ~  21.8M tok  sessions touched today

  Antigravity    last used 1d4h ago
    quota           ████████████████████ 100%              resets 2026/09/13 09:23(Sun) · in 23h53m
    last 5h         ────────────────────   — ~      0 req  model generations
    7 days          ────────────────────   — ~  1,204 req  rolling

  ~ derived locally (estimate)  ·  unmarked = reported by the vendor
```

Everything but the Claude Code percentages is read from local files. Those come
from the same API call Claude Code's own `/usage` makes — see
[Claude Code percentages](#claude-code-percentages). Pass `--offline` to skip it.

## Requirements

- macOS (paths are the macOS locations of each agent's data directory)
- [mise](https://mise.jdx.dev) — pins Node 26 and pnpm

## Install

```bash
mise trust && mise install
pnpm install
ln -s "$PWD/bin/goso" ~/.local/bin/goso
```

`bin/goso` runs the CLI through mise, so the pinned Node is used from any
directory. There is no build step: Node 26 executes the TypeScript sources
directly via type stripping.

## Usage

```bash
goso                      # the table above
goso -v                   # add per-provider notes
goso --json               # machine-readable snapshot
goso -1                   # one line: the window closest to its limit
goso --only codex,claude  # a subset
goso --watch 60           # redraw every 60s
goso --offline            # local files only, no API call
```

## What each number means

The tilde (`~`) is the important part of the display: it marks a number `goso`
computed itself. Unmarked numbers came from the vendor.

| Agent | Source | Reported or derived |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` | **Reported.** Codex writes the server's own rate-limit state (`used_percent`, `resets_at`, plan) into every `token_count` event. |
| Claude Code | `GET /api/oauth/usage`, plus `~/.claude/projects/**/*.jsonl` | **Reported** percentages and resets; token totals derived from each message's `usage` block. |
| Antigravity | `~/.gemini/antigravity*/conversations/*.db` | **Derived**, except the quota row. Model generations are counted from the SQLite step log. When Antigravity has hit a 429, the server's own "resets in …" is shown as a `quota` row. |

An agent that is not installed, or has had no activity for 7 days, is listed as
`unavailable` with the reason.

### Not covered: the Gemini desktop app

Its **使用量上限 / Usage limits** panel is not reproducible offline. Nothing about
it reaches disk: not the Core Data stores under
`~/Library/Application Support/com.google.GeminiMacOS`, not the `NSURLCache`
(images only), not WebKit storage, not the preferences. The diagnostic log
records only `Quota info updated, 0 modes over quota` — no numbers — and its
last entry is what the panel's "更新: N分前" is counting from.

The app gets the figures over an undocumented internal Google RPC
(`CheckGeminiQuota` / `CheckGxuBudget`, per the strings in its binary),
authenticated with the Google account token it keeps in
`Data/user1/auth`. Replaying that would mean reverse-engineering internal
protos that can change without notice, so `goso` does not.

### Claude Code percentages

Claude Code fetches its quota from `GET /api/oauth/usage` and never writes the
result to disk, so there is no local file to read. `goso` makes the same call,
which means the session, weekly and per-model percentages match what `/usage`
prints exactly.

The OAuth token comes from the login keychain item `Claude Code-credentials`
(or `~/.claude/.credentials.json` where that exists). It is read, sent as a
bearer header, and dropped — never logged, never cached, never included in an
error message. Only the returned percentages and reset times are cached, for 60
seconds, in `~/.cache/goso/claude-usage.json`.

macOS asks for permission the first time; choose **Always Allow** to stop it
asking again. To opt out entirely, run with `--offline` or set
`claude.useKeychain: false` in the config.

Without that call — offline, opted out, or a token that needs refreshing —
`goso` falls back to reconstructing the 5-hour window the way the session
windows behave: a block opens on the hour of its first message, closes 5 hours
later, and a 5-hour gap with no traffic opens a fresh one. Token totals stay
exact either way; the block boundary is the estimate.

## Optional config

Claude Code percentages need no config. The other agents' derived counts show
as raw amounts, because vendors do not publish per-plan quotas in
machine-readable form. Fill in the limits you know and `goso` turns them into
percentages and bars:

`~/.config/goso/config.json`

```json
{
  "claude": { "fiveHourTokens": 88000000, "weeklyTokens": 440000000, "useKeychain": true },
  "antigravity": { "fiveHourRequests": 300, "weeklyRequests": 12000 }
}
```

## Raycast

The `raycast/` directory is a Raycast extension with two commands:

- **AI Agent Usage** — an **Overview** section at the top, then the full
  per-agent breakdown, with copy-as-text and copy-as-JSON actions.

  Overview answers one question — can I use this right now? — with one row per
  agent: its shortest window, which is the one you hit mid-task. A window
  already at its ceiling wins regardless of length, since a spent weekly quota
  stops you just as dead. Longer windows and raw counts stay in the per-agent
  sections below, where there is room to read them.

  ```
    Overview                                     can you use it right now?
      Antigravity   quota            2026/09/13 09:23(Sun)   100%
      Claude Code   session limit    2026/09/12 13:00(Sat)    31%
      Codex         5h limit         2026/09/12 11:45(Sat)    18%
  ```

- **AI Agent Usage in Menu Bar** — keeps the tightest quota percentage in the
  menu bar and refreshes every 10 minutes

```bash
pnpm raycast:install
pnpm raycast:dev      # imports the extension into Raycast and hot-reloads
pnpm raycast:build    # production build
```

**Install the CLI first.** Raycast's embedded Node has no `node:sqlite`, so it
cannot read Antigravity's conversation databases on its own. The extension
therefore shells out to the `goso` CLI, which runs on Node 26 through mise, and
falls back to in-process collection — everything except Antigravity — when the
CLI is missing. The fallback is labelled in the UI rather than failing silently.

The extension looks for `goso` in `~/.local/bin`, `/opt/homebrew/bin` and
`/usr/local/bin`; set **goso CLI path** in the extension's preferences to point
somewhere else. `bin/goso` resolves its own symlink and finds `mise` without
relying on `PATH`, because Raycast spawns it with a minimal environment.

The extension installs standalone rather than as a workspace member, because
`ray` resolves `typescript` and `esbuild` from the extension's own
`node_modules`. It links `@goso/core` from this repo, so the CLI and the
extension always report identical numbers.

## Privacy

`goso` makes exactly one network request: `GET /api/oauth/usage` to
`api.anthropic.com`, for the Claude Code percentages. `--offline` skips it and
nothing leaves the machine at all. There is no telemetry and no other
destination.

The OAuth token is read from the login keychain, sent as a bearer header, and
dropped. It is never logged, never written to disk, and never included in an
error message — the keychain failure text is deliberately vague for that
reason. The only thing cached is the returned percentages and reset times, for
60 seconds, in `~/.cache/goso/claude-usage.json`.

Everything else is read from files the agents already wrote. `goso` opens
their SQLite databases read-only and never writes to them.

Two more caches live beside that one, holding only derived counts — token
totals per transcript, request timestamps per conversation — so a repeated run
does not re-read inputs that have not changed. Delete `~/.cache/goso` at any
time; it is rebuilt on the next run.

## Development

```bash
pnpm test        # node:test
pnpm typecheck   # tsc --noEmit
pnpm goso        # run the CLI from the repo
pnpm sample      # regenerate the README samples
```

The samples above come from a fixed fixture in `scripts/sample.ts`, rendered
through the real renderer. Regenerate them with `pnpm sample` rather than
pasting a real run — a real run publishes your plan tier, quota levels and
activity times.

### Layout

```
packages/core/   providers, formatting, ranking — no I/O beyond reading agent files
packages/cli/    argument parsing and terminal rendering
raycast/         Raycast extension (standalone install, calls bin/goso)
bin/goso         launcher that pins Node via mise
scripts/sample   renders the README samples from a fixture
```

Adding an agent means adding one file under `packages/core/src/providers/` that
returns a `ProviderSnapshot`, and listing it in `PROVIDER_IDS`. A provider that
throws is reported as `error` for that row only — it never fails the run.

### Performance

Claude Code's transcripts run to hundreds of megabytes — a few hundred files of
very long lines — and Antigravity keeps a SQLite database per conversation, so
a naive scan dominates the run. Two things keep it fast:

- Only lines carrying both `"usage"` and `"type":"assistant"` are decoded. The
  scan works on raw bytes, so the bulk of the data is never turned into a
  string.
- Each file's contribution is cached against its size (and for transcripts, the
  head bytes). Transcripts are append-only, so only the bytes added since the
  last run are read; conversation databases are skipped whole when unchanged.

That is roughly 950ms on a cold cache — most of it the one network call — and
about 200ms after.

## License

MIT
