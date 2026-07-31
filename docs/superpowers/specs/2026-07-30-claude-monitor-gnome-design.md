# Claude Monitor — GNOME Shell indicator

**Date:** 2026-07-30
**Status:** implemented

## Goal

A GNOME Shell top bar indicator showing Claude Code usage limits, refreshing
every minute, always displaying the signed-in account email.

## Requirements

- Panel shows session usage and weekly usage: `48% | 75%`.
- Each number is coloured independently: `> 90%` red, `> 60%` yellow, else green.
  Thresholds are exclusive — exactly 90 is still yellow.
- Refresh every 60 seconds.
- Clicking opens details: account email, session usage, weekly usage across all
  models, and weekly Fable usage.
- All user-facing strings in English.

## Environment (verified, not assumed)

- GNOME Shell 42.9 on X11 → legacy `imports.gi.*` API, **not** ESM.
  `init()` / `enable()` / `disable()` in `extension.js`.
- GJS 1.72.4 — has Promises, `async`/`await`, optional chaining.
- libsoup **2.4 only**; Soup 3 is absent. So `Soup.Session.queue_message`,
  not `send_and_read_async`. Confirmed callable from gjs against the real
  endpoint (returned 401 for a bogus token).

## Data source

Live API primary, local cache as fallback.

| Field | Source |
| --- | --- |
| email | `~/.claude.json` → `oauthAccount.emailAddress` |
| token | `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` |
| usage (live) | `GET https://api.anthropic.com/api/oauth/usage` |
| usage (fallback) | `~/.claude.json` → `cachedUsageUtilization.utilization` |

The live response and the cached object share the same inner shape, so one
parser handles both.

Field mapping, verified against a real response:

| UI row | Source |
| --- | --- |
| Session (5h) | `limits[kind == "session"]` |
| Week \| all models | `limits[kind == "weekly_all"]` |
| Week \| Fable | `limits[kind == "weekly_scoped" && scope.model.display_name == "Fable"]` |

If `limits` is absent (older accounts), fall back to the top-level `five_hour`
and `seven_day` keys. Fable matching is case-insensitive.

### Rejected alternatives

- **Cache only.** Zero network and zero token handling, but the numbers freeze
  whenever Claude Code is not running — which is exactly when you would glance
  at the panel.
- **Live only.** Simpler than the hybrid, but an expired token with no fallback
  leaves the indicator blank until you happen to open Claude Code.

## Decisions

**No token refresh.** On 401/403 the extension reports
`Token expired — open Claude Code to refresh it` and falls back to the cache.
Writing to `.credentials.json` from outside Claude Code risks corrupting the
session; the cost of not doing it is one stale reading.

**No `prefs.js`.** Interval and thresholds are fixed by the requirements. A
settings panel would be dead weight.

**Empty state is `— | —`, not a hidden indicator.** A hidden indicator is
silent about its own failure.

## Architecture

Four units. The split exists so everything but the widgets is testable without
a Shell.

| File | Responsibility | Depends on |
| --- | --- | --- |
| `usage.js` | Read files, call API, back off, fall back to cache, normalise | Gio/GLib/Soup — **no St/Shell** |
| `login.js` | Find a terminal, run `claude auth login` | GLib — **no St/Shell** |
| `indicator.js` | Panel button and dropdown | St/PopupMenu + `usage.js` + `login.js` |
| `extension.js` | Lifecycle, 60s timer | `indicator.js` |

`usage.js` exposes one entry point:

```js
fetchUsage({ force }) -> Promise<{
    email:     string | null,
    usage:     { session, weekAll, weekFable } | null,  // each: {percent, resetsAt}
    source:    'live' | 'cache' | null,
    ageMs:     number,
    retryInMs: number,      // > 0 only while backing off from a 429
    error:     null | 'no-auth' | 'expired' | 'offline' | 'rate-limited',
}>
```

It never rejects — the indicator always receives something renderable. `force`
skips an active backoff and is used only by the refresh button.

## Data flow

Every 60s, and on menu open:

1. Read `~/.claude.json` — one read yields both the email and the fallback.
2. If a rate-limit backoff is active, skip straight to the cache.
3. Read the token from `~/.claude/.credentials.json`.
4. `GET /api/oauth/usage` → `source: 'live'`, and clear any backoff.
5. On failure use the cached object → `source: 'cache'`, reason shown in the menu.
6. Neither available → `usage: null`, panel renders `— | —`.

## Error handling

| Condition | `error` | Menu text |
| --- | --- | --- |
| No token file or no token | `no-auth` | Not signed in — use Switch Account to sign in |
| HTTP 401 / 403 | `expired` | Token expired — sign in again to refresh it |
| HTTP 429 | `rate-limited` | Rate limited by the usage API, retrying in `N`m |
| Network failure, other non-200, bad JSON | `offline` | Usage API unreachable |

When `source == 'cache'` the menu appends `Showing cached data from <age>`.

Two lifetime hazards, both handled in `indicator.js`: a request in flight when
the extension is disabled (`_destroyed` flag), and a slow request landing after
a newer one (monotonic `_generation` counter). `disable()` also aborts the Soup
session.

## Testing

`gjs test/run-tests.js` — 99 assertions over the pure layer: parsing live and
cached payloads, the `five_hour`/`seven_day` fallback, Fable scope matching
(including case-insensitivity and not mistaking another scoped model for
Fable), degraded inputs, colour thresholds at the 60/90 boundaries, and time
formatting including the microsecond-precision timestamps the API emits.

`gjs test/smoke-live.js` — runs the real file + HTTP chain outside the Shell and
prints what the panel would render. Asserts nothing; it exists so the IO half
can be checked without a Shell restart.

## Revision — 2026-07-31

Verified in place, then revised after review of the running extension.

**Icon.** Replaced the hand-drawn burst with the official Claude symbol
([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg)),
inset 6% so it matches neighbouring status icons, in the brand orange
`#D97757` — `hsl(14.8, 63.1%, 59.6%)` from the source file.

Two things about this were established by measurement, both counter-intuitive
enough to be worth recording:

- **The colour does not come from the SVG.** St tints any `-symbolic.svg` icon
  with the CSS `color` property, overriding the file's own `fill`. Verified by
  removing `.claude-monitor-box .system-status-icon { color: … }` and reloading:
  the icon renders white despite `fill="#D97757"`. The `fill` and the CSS rule
  carry the same value and must be changed together.
- **gdk-pixbuf sniffs the file format from a 256 byte window.** The attribution
  comment originally sat ahead of the `<svg>` root, pushing it to byte 262, and
  the panel silently showed no icon at all — the extension loaded fine, there
  was just a gap. The cutoff is sharp: bisecting 250–274 shows every offset
  ≤ 256 loading and every offset ≥ 257 rejected. The comment now lives inside
  the root element, where its length cannot matter.

The second one is invisible in code review and produces no error in the
journal, so `run-tests.js` now loads the icon through the same loader GNOME
uses and asserts it draws something. That guard was itself checked against the
broken file before being trusted.

**Row labels.** `Week — all models` / `Week — Fable` became
`Week | all models` / `Week | Fable`, matching the pipe the panel already uses.

**Refresh.** The `Refresh now` menu item became an icon-only
`view-refresh-symbolic` button in the header row, right of the email.

**Switch Account.** New menu item, spawning `claude auth login` in a terminal.
`claude auth login` is a real subcommand — better than passing `/login` as a
prompt. Two things this has to get right, both covered by tests:

- The command runs under `bash -lc`. gnome-shell's environment does not include
  `~/.local/bin`, where the CLI lives; a login shell picks it up via `~/.profile`.
- Terminals are tried in order from a table, first installed wins.
  `gnome-terminal` leads because its `--` separator takes a real argv, where the
  `-e` variants need a quoted string. If none is found, the extension notifies
  rather than failing silently.

Lives in its own `login.js` — spawning a terminal is neither data nor UI.

**Alignment fix.** The reset-time column had no minimum width, so a long row
label butted against it. It now has `min-width` and horizontal padding, and the
label is kept (empty) rather than hidden when a row has no reset time, so the
three columns line up.

**Rate limiting.** Found while verifying the finished extension, not designed
for: the usage endpoint returns `429 rate_limit_error` under a 60 second poll.
Two defects followed from it.

The first was a lie in the UI. `429` fell into the catch-all `offline` branch,
whose menu text is `Usage API unreachable` — but the API was perfectly
reachable and was refusing us on purpose. `rate-limited` is now its own error
code with its own wording.

The second was worse: with no backoff, the extension kept polling every 60
seconds throughout the block, which can only prolong it. It now waits 2
minutes, doubling per consecutive `429` to a 30 minute cap, cleared by the
first success. `Retry-After` is honoured when it asks for longer — the API
sends `0` when it has no opinion, and that must not be read as "retry
immediately".

The refresh button passes `force` to skip the backoff. A person pressing it is
not the traffic that caused the throttling, and a button that visibly does
nothing reads as broken.

That Claude Code caches this value in `~/.claude.json` rather than querying
live now looks less like an implementation detail and more like a hint about
the endpoint's intended use — a hint that turned out to be measurable, below.

## Revision — polling cadence

Researching how to avoid the `429` found the actual cause, and it was not the
missing backoff.

Claude Code owns this endpoint, and its self-imposed cadence is readable in its
binary: it refuses to refresh its cached utilization more often than every
**5 minutes** (`NZg = 300000`) and treats the value as usable for an **hour**
(`$Zg = 3600000`). It has no `429` handling at all — it protects itself purely
by not asking often. Polling every 60 seconds was five times faster than the
tool that owns the endpoint.

The endpoint also returns **none** of the `anthropic-ratelimit-*` headers the
Messages API documents — only `retry-after: 0`, observed still returning `429`
twenty minutes later. There is nothing to steer by, which makes matching Claude
Code's cadence the only available strategy.

A `Gio.FileMonitor` on `~/.claude.json` picks up a newer cached value for free
when Claude Code writes one.

**Two corrections to the first version of this section, both found by
measuring rather than reasoning.** They are recorded because the reasoning that
produced them looked sound:

- `NZg` guards the *write to disk*, not the API call — a disk-churn throttle.
  It was read here as "Claude Code refuses to ask more often than every 5
  minutes". Neither constant states a polling interval; Claude Code fetches on
  events, not on a timer.
- The file watcher was claimed to keep the panel current during active use at
  no API cost. It does not: `cachedUsageUtilization` was measured **46 minutes
  stale during continuous use, with the endpoint returning 200**. The watcher is
  opportunistic; **the 5-minute poll is what bounds staleness.**

Neither correction changes the decision — if anything they strengthen it, since
Claude Code asks even less often than the constants suggested. But the second
one caused a real bug (below), so the distinction earns its place here.

Net result: ~5× fewer requests, staleness bounded by the poll, age always
visible. Changes:

- Poll 60s → 300s, jittered ±10%.
- `Gio.FileMonitor` on `~/.claude.json`, debounced 2s (the file carries plenty
  of unrelated state that changes often), triggering a **cache-only** refresh.
- Cache-only reads resolve to `{skip: true}` when nothing is cached, so a
  watcher event can never blank out good live data.
- Menu-open reads the cache instead of hitting the API — a request per
  menu-open is a fast route to being throttled.
- Backoff gained ±20% jitter, matching Anthropic's documented reference retry,
  so clients recovering from one outage don't resynchronise into the next.
- `5xx` now backs off too — same "slow down" signal as a `429`. Network errors
  don't; nothing server-side is struggling.

**Age is now shown permanently**, in the header beside the refresh button
(`updated 2m ago`), recomputed from an absolute timestamp and ticking every 15s
while the menu is open. It replaces the `Showing cached data from …` warning:
serving the cache is the normal path now, not a fault, and the yellow status
line is reserved for real errors.

## Bug — the watcher overwrote fresher data with an older cache

Reported from the running extension: the panel showed session `0%` and said it
was cached; pressing `⟳` fixed it; about four seconds later it reverted to `0%`
and "cached" again.

The file watcher fires on **any** write to `~/.claude.json`, and Claude Code
writes it for reasons unrelated to usage — measured: one write in 30 seconds
with `cachedUsageUtilization` untouched. Each of those triggered a cache-only
render, which replaced the just-fetched live value with a 45-minute-old
reading of `0%`. The four-second delay was the watcher's 2s debounce.

The cache-only path rendered unconditionally. It had a guard for *no cache at
all* (`{skip: true}`) but not for *cache older than what is on screen* — the
case that actually occurs, and the one the freshness misconception above made
easy to overlook.

Fixed with `cacheSupersedes(cachedAtMs, displayedAtMs)`: a cache read may only
replace what is displayed if it is **strictly newer**. Callers pass the
displayed data's timestamp as `notOlderThanMs`; the indicator supplies its own,
so no caller has to remember. Equal timestamps don't re-render, and a cache of
unknown age never wins.

Full field notes, measured values, and reproduction commands:
[`docs/anthropic-usage-endpoint.md`](../../anthropic-usage-endpoint.md).

Test count: 41 → 110 assertions.
