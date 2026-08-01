# Claude Monitor | GNOME Shell Extension

Shows your Claude Code usage limits in the top bar.

```
✳ 48% | 75%
```

Left is the current session (5 hour) window, right is the rolling 7 day window.
Each number is coloured independently:

| Usage | Colour |
| ----- | ------ |
| `> 90%` | red |
| `> 60%` | yellow |
| `> 30%` | the theme's own text colour |
| otherwise | green |

Clicking the indicator opens the details:

```
you@example.com                    updated 2m ago   ⟳
────────────────────────────────────────────────────
Session (5h)          resets in 3h 52m          80%
Week | all models     resets in 12h 22m         79%
Week | Fable                                     0%
────────────────────────────────────────────────────
Switch Account
```

`updated 2m ago` is how old the displayed numbers are; it keeps counting while
the menu is open. `⟳` fetches fresh ones immediately. **Switch Account** opens
`claude auth login` in a terminal window, so you can sign in as a different
account.

## Requirements

- GNOME Shell 42
- Claude Code, signed in (the extension reads its credentials; it never writes them)
- A terminal emulator, for Switch Account — `gnome-terminal`, `kgx`, `konsole`,
  `xfce4-terminal`, `alacritty`, `kitty`, `xterm` or `x-terminal-emulator`

## Install

From the repository root:

```sh
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/claude-monitor@anarkrypto
```

The **link's** name has to be `claude-monitor@anarkrypto` — GNOME Shell matches
the directory name against the UUID in `metadata.json` and ignores anything
that doesn't. The clone itself can be called whatever you like; only the link
name matters.

Restart GNOME Shell so it picks up the new directory — on X11 press
<kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, press <kbd>Enter</kbd>. On Wayland you
have to log out and back in. Then:

```sh
gnome-extensions enable claude-monitor@anarkrypto
```

## Where the data comes from

1. **`GET https://api.anthropic.com/api/oauth/usage`**, authenticated with the
   token from `~/.claude/.credentials.json`. Polled every **5 minutes** (±10%).
   This is what bounds how stale the numbers can get.
2. **`~/.claude.json`** → `oauthAccount.emailAddress` (the signed-in account)
   and `cachedUsageUtilization` (a fallback copy of the numbers). The extension
   watches this file and picks up a newer value for free when one appears — but
   only when it is **strictly newer** than what's already displayed, because
   Claude Code rewrites the file constantly for unrelated reasons.
3. **`~/.claude/.credentials.json`** → the OAuth token, and what it says about
   itself. This file is watched too, for a different reason: it carries no usage
   data, but a write to it is the one event that can end an authentication
   fault. See [The token, and mornings](#the-token-and-mornings).

The header shows how old the displayed numbers are (`updated 2m ago`). If
neither source is available the panel shows `— | —`.

> Claude Code refreshes its cached copy on events, not on a timer — measured at
> 46 minutes stale during continuous use. Treat the file as an opportunistic
> shortcut, not a freshness guarantee; the poll is the guarantee.

### Rate limiting

The usage endpoint rate-limits and returns **no** `anthropic-ratelimit-*`
headers to steer by — only `retry-after: 0`, which carries no information.
With nothing to calibrate against, the only strategy left is to ask rarely.
Claude Code, which owns this endpoint, has no `429` handling at all and simply
asks very little — measured at 46 minutes between refreshes during continuous
use. Five minutes is already well above that.

If it gets throttled anyway, it backs off 2 minutes, doubling per consecutive
`429` (and per `5xx`) to a 30-minute cap with ±20% jitter, cleared by the first
success. `Retry-After` is honoured only when it asks for **longer** — this
endpoint sends `0` meaning "no opinion", and obeying that literally means
retrying straight into a refusal.

The `⟳` button ignores the backoff. A person pressing it is not the traffic
that caused the throttling, and a button that does nothing reads as broken.

**Full field notes — measured values, the reasoning, and how to re-verify it
all — are in [`docs/anthropic-usage-endpoint.md`](docs/anthropic-usage-endpoint.md).**

**The extension never writes to your Claude Code files.** When the OAuth token
expires it says so and falls back to the cache rather than attempting a refresh
itself; rewriting `.credentials.json` from outside Claude Code risks corrupting
the session.

### The token, and mornings

The access token lives **8 hours**. A machine that suspends overnight therefore
wakes up with a dead one, and this is the single most likely fault to be on
screen — it is what the first refresh after unlock finds.

Two things follow from *not* refreshing the token ourselves:

- **The panel reads the expiry instead of discovering it.** `expiresAt` is right
  there in the file, so an expired token is reported as expired without spending
  a request to be told `401`. A missing or malformed expiry field is treated as
  no information and the token is sent anyway — refusing to ask because a field
  we don't own changed shape would be a much worse failure than one wasted
  request.
- **It waits for the fix rather than asking you to perform it.** A dead access
  token sitting beside a live refresh token is not a signed-out session: Claude
  Code mints a new one on its next call. So the status row says *"Token expired
  — run Claude to refresh it"*, and the extension watches
  `~/.claude/.credentials.json` so the panel recovers within the watcher's 2
  second debounce of that happening, instead of waiting up to 5 minutes for the
  next poll. Only when the **refresh** token is dead too does it say *"Not
  signed in"* and point you at **Switch Account** — that is the one case where
  signing in again is genuinely the way back.

A write to the credentials file only costs a request when there is an
authentication fault on screen for a new token to fix. Claude Code rotates the
token every few hours regardless, and paying a request per rotation would buy
nothing the poll isn't already delivering — and on a throttled panel it would do
active harm.

### Account switching

A switch is detected from `~/.claude.json` within a couple of seconds — the
file watcher's 2 second debounce — however it was performed: the **Switch
Account** button above, `claude auth login` run in any terminal, or `/login`
inside Claude Code itself. Signing out, and signing out then straight back in
as someone else, are both handled the same way; the second is worth calling
out because it's an ordinary way to change accounts, not an edge case.

When the switch is noticed without the new account's numbers to hand — the
usual case, since the file watcher notices it first — the panel clears to
`— | —` and shows the new email immediately, rather than holding the previous
account's numbers until fresh ones arrive.
The panel is read at a glance, and a wrong number read at a glance is worse
than an em dash. Holding also has the worse failure mode: going offline
mid-switch would strand one account's usage sitting under another account's
name, with nothing on screen to say so. For the same reason, a usage cache
left over from a different account is ignored rather than shown — see
[`docs/anthropic-usage-endpoint.md`](docs/anthropic-usage-endpoint.md) for why
one can be sitting on disk at all. A cache written *before* the switch is
refused outright, on top of that check: the cache is stamped with an account
but never with an organisation, so the same account moved between
organisations — which gets different limits, and so counts as a switch — leaves
one behind that the stamp cannot rule out.

If the switch is instead noticed by the 5 minute poll or by pressing `⟳`, the
new account's numbers are already in hand, so they go straight up: no clear, no
second request.

Immediately after a switch the extension retries briefly — at 2s, 5s, then
10s — if the new account's token hasn't been written to disk yet, so a
successful login never gets reported as "Token expired" or "Not signed in" as
if it were a fault. A genuine sign-out isn't retried: "Not signed in" shows up
immediately, because there is no token to wait for.

## Changing the icon colour

The panel icon uses the Claude brand orange, `#D97757`. It is set in **two**
places that must stay in sync:

- `icons/claude-monitor-symbolic.svg` — the path's `fill`
- `stylesheet.css` — `.claude-monitor-box .system-status-icon { color: … }`

The stylesheet is the one that actually wins: St tints `-symbolic.svg` icons
with the CSS `color` property and ignores the file's own `fill`. To follow the
panel foreground instead, like a standard status icon, delete the CSS rule.

## Layout

| File | Responsibility |
| --- | --- |
| `usage.js` | Token, API call, cache fallback, parsing — no St/Shell |
| `login.js` | Finds a terminal and runs `claude auth login` — no St/Shell |
| `indicator.js` | Panel button and dropdown |
| `extension.js` | Lifecycle, the 5 minute poll, the two file watchers |

## Tests

`usage.js` and `login.js` import no St/Shell symbols, so they run under plain
`gjs`:

```sh
gjs test/run-tests.js    # 248 assertions, no network, no credentials
gjs test/smoke-live.js   # real end-to-end run: prints what the panel would show
```

`run-tests.js` covers parsing, the five_hour/seven_day fallback, Fable scope
matching, colour thresholds, time formatting, account-switch detection, and the
terminal argv table — a typo there would otherwise only surface the day someone
clicks Switch Account. Its last section is asynchronous: it stubs `usage.js`'s
own file and HTTP functions through the module object to assert what
`fetchUsage` returns on each of its paths. `smoke-live.js` asserts nothing; it
exists so the file and HTTP half can be checked without restarting the Shell.

## Development

Installed as a symlink, so editing files here is editing the live extension.
What it takes to see a change depends on what you changed — established by
doing it, not from documentation:

| Changed | To reload |
| --- | --- |
| `stylesheet.css` | `gnome-extensions disable … && gnome-extensions enable …` |
| any `.js` | Full Shell restart — GJS caches imported modules |
| `icons/*.svg` | Full Shell restart — St caches textures by file URI |

On X11 a Shell restart is <kbd>Alt</kbd>+<kbd>F2</kbd>, `r`, <kbd>Enter</kbd>.
Note that this is *not* the same as killing the process: the systemd unit has
`OnFailure=gnome-session-failed.target`, so a signal-killed Shell lands you on
the session failure screen. `Meta.restart()`, which `r` calls, exits with
status 1 — declared as `SuccessExitStatus` — and reloads in place.

## Troubleshooting

```sh
journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude-monitor
```
