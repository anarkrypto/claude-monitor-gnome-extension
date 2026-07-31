# The Claude usage endpoint, and its rate limits

Field notes on `GET https://api.anthropic.com/api/oauth/usage` — the endpoint
behind Claude Code's `/usage` and behind this extension's panel numbers.

Everything here was **measured on 2026-07-31**, not taken from documentation.
The endpoint is undocumented, so the numbers below may drift; the reproduction
commands are included so they can be re-checked rather than trusted.

---

## The endpoint

```sh
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $(python3 -c "import json;print(json.load(open('$HOME/.claude/.credentials.json'))['claudeAiOauth']['accessToken'])")" \
  -H "anthropic-beta: oauth-2025-04-20"
```

Returns the account's rate-limit *utilization* — not token counts:

```json
{
  "five_hour": {"utilization": 49.0, "resets_at": "..."},
  "seven_day": {"utilization": 75.0, "resets_at": "..."},
  "limits": [
    {"kind": "session",       "percent": 49, "resets_at": "...", "scope": null},
    {"kind": "weekly_all",    "percent": 75, "resets_at": "...", "scope": null},
    {"kind": "weekly_scoped", "percent": 0,  "resets_at": null,
     "scope": {"model": {"display_name": "Fable"}}}
  ]
}
```

Auth is the OAuth token on `Authorization: Bearer`, **not** `x-api-key`, plus
the `anthropic-beta: oauth-2025-04-20` header.

---

## It rate-limits, and it tells you almost nothing

Exceeding it returns a normal `429`:

```json
{"error": {"type": "rate_limit_error", "message": "Rate limited. Please try again later."}}
```

The response headers are the important part — or rather, what is missing from
them:

| Header | Present? | Useful? |
| --- | --- | --- |
| `retry-after` | yes, always `0` | **No.** Observed still-429 twenty minutes after a `retry-after: 0` |
| `anthropic-ratelimit-requests-remaining` | **no** | — |
| `anthropic-ratelimit-requests-reset` | **no** | — |
| any other `anthropic-ratelimit-*` | **no** | — |

This is the trap. The [Messages API rate-limit
docs](https://platform.claude.com/docs/en/api/rate-limits) describe a rich set
of `anthropic-ratelimit-*` headers and define `retry-after` as *"the number of
seconds to wait until you can retry"* — but **this endpoint is not the Messages
API and returns none of that**. Its `retry-after: 0` is not an instruction to
retry immediately; it is an unset field. Code that trusts it will hammer a
server that is actively refusing.

Full header list observed on a 429: `date`, `content-type`, `content-length`,
`retry-after`, `cache-control`, `expires`, `referrer-policy`, `x-frame-options`,
`content-security-policy`, `x-robots-tag`, `server`, `cf-ray`.

---

## What the rate actually is

Not published. But there is a strong proxy: **Claude Code owns this endpoint,
and its self-imposed cadence is readable in the binary.**

```sh
CB=$(readlink -f ~/.local/bin/claude)
grep -aoE 'await Pi\.get\("/api/oauth/usage".{0,300}' "$CB"
```

Claude Code's call carries `timeout: 5000` and `refreshOAuth: true`, and its
only retry path is `401 → refresh token → retry`. **It has no 429 handling at
all** — it protects itself purely by not asking often. Two constants govern
that, found next to `cachedUsageUtilization`:

| Constant | Value | Role |
| --- | ---: | --- |
| `NZg` | `300000` ms — **5 minutes** | Throttles **persisting** the value to disk |
| `$Zg` | `3600000` ms — **1 hour** | Read TTL: treats a cached value as usable for this long |

```js
// write path — skips the write entirely if the stored value is younger than NZg
let o = n && n.accountUuid === r ? Date.now() - n.fetchedAtMs : Number.POSITIVE_INFINITY;
if (o >= 0 && o < NZg) return;

// read path — treats anything older than $Zg as absent
let r = Date.now() - t.data.fetchedAtMs;
if (r < 0 || r > $Zg) return null;
```

> **Read `NZg` precisely.** It guards the *write to `~/.claude.json`*, not the
> API call. It is a disk-churn throttle. Neither constant states a polling
> interval — Claude Code fetches utilization on events, not on a timer.

The stronger signal is `$Zg`: **Claude Code is content to show you an
hour-old number.** And the observed behaviour is more conservative still —
`cachedUsageUtilization` was measured **46 minutes stale during continuous
active use, with the endpoint returning 200** (so throttling was not the
cause). Claude Code simply does not ask often.

Against that, polling every 60 seconds is not five times too aggressive — it is
far more than that, and this extension was throttled for over twenty minutes as
a result.

---

## The local cache

`cachedUsageUtilization` is not just a number and a timestamp. Its stored
shape, read off the same write path quoted above, is:

```
{ fetchedAtMs, accountUuid?, utilization }
```

`accountUuid` is genuinely optional in Claude Code's own schema — the write
path only spreads it onto the record when the signed-in account has one
(`...r !== void 0 && {accountUuid: r}`). An unstamped cache is not malformed
data; it is what the schema allows, which is why this extension treats one as
belonging to whoever is signed in rather than as untrustworthy.

Ownership is checked on read, not on write — and only there. The read
function compares the cache's `accountUuid` against whoever is signed in now,
and drops the whole entry on a mismatch:

```js
// read path — deletes the cache outright if it is stamped for someone else
if (t.data.accountUuid !== dc()?.accountUuid)
    return hr(n => ({...n, cachedUsageUtilization: void 0})), null;
```

That check fires the next time Claude Code *reads* the cache, not the moment
the account changes. In the gap between a switch and that next read,
`~/.claude.json` can legitimately hold the new account's `oauthAccount` right
next to the old account's `cachedUsageUtilization` — the file is briefly
self-inconsistent by design, not by bug. That gap is the whole reason this
extension carries its own ownership check instead of trusting the file to
already be clean by the time it reads it.

Logout is handled differently: `cachedUsageUtilization` is cleared in the same
state update that clears `oauthAccount`, not lazily on the next read —

```js
s.oauthAccount = void 0, /* … */ s.cachedUsageUtilization = void 0, s
```

— so there is no equivalent gap on sign-out. The gap exists only when signing
in as a different account, which is exactly when it matters least to Claude
Code and most to a panel that renders numbers next to an email address.

All three of the above — the record's shape, the lazy read-time ownership
check, and the logout clear — were read out of the shipped Claude Code binary
at **version 2.1.220**, the same way the cadence constants above were: none of
it is public API, and it may have changed by the time you read this. Re-check
it rather than trust it.

The binary is an ELF executable with the JS bundled straight into it, not a
text file. A plain `grep cachedUsageUtilization <binary>` reports no matches
and looks like proof the key doesn't exist — it isn't; grep just refuses to
search binary data unless told to with `-a`, as the reproduction command above
already does.

---

## What the official docs do apply

Three things from the [Messages API rate-limit
docs](https://platform.claude.com/docs/en/api/rate-limits) transfer even though
the headers don't:

- **Token bucket, not fixed windows.** Capacity replenishes continuously rather
  than resetting on a boundary, so recovery is gradual — there is no moment at
  which the budget is restored in full.
- **Short intervals bite.** *"A rate of 60 requests per minute might be enforced
  as 1 request per second."* Bursts trip limits that an averaged rate would not.
- **Ramp gradually, keep the pattern steady.** The docs name sharp usage
  increases as a trigger for acceleration limits.

Anthropic's own reference retry adds **random jitter** to exponential backoff
(`base * 2^attempt + random(0, 1)`), so that clients recovering from one outage
do not resynchronise into the next.

---

## What this extension does about it

Design consequences, each traceable to a line above:

| Decision | Because |
| --- | --- |
| API poll every **5 min**, not 60s | The only strategy available: the endpoint gives no headers to calibrate against, and Claude Code's own behaviour sits far below this rate |
| Poll interval jittered ±10% | Bursts trip limits; machines shouldn't converge on the same second |
| Watch `~/.claude.json` for changes | Opportunistic free update when Claude Code *does* refresh — see the caveat below |
| A cache read may only replace **strictly newer** data | The watcher fires on any write to the file, and most writes don't touch usage. Without this, a 45-minute-old cache overwrites a just-fetched live value |
| Menu-open reads cache only | A request per menu-open is a fast route to being throttled |
| `retry-after` honoured only when **> 0** | This endpoint sends `0` meaning "no opinion", and obeying it literally means retrying into a refusal |
| Backoff 2 min → ×2 → 30 min cap, **+0–20% jitter** | Mirrors the documented reference retry |
| Backoff on `429` **and `5xx`** | Both are the server saying slow down. Network errors are not — nothing server-side is struggling |
| Backoff cleared by the first success | One bad minute shouldn't cost the next hour |
| The `⟳` button bypasses the backoff | A person clicking once is not the traffic that caused the throttling |
| The header shows **how old the numbers are** | With a 5-minute floor and a cache that can lag much further, age is not a footnote — it is part of reading the value |

> ⚠️ **The file watcher is a bonus, not a freshness strategy.** An earlier
> version of this document claimed it would keep the panel current during
> active use at no API cost. That was wrong, and measuring it is what showed
> so: `cachedUsageUtilization` went 46 minutes without advancing during
> continuous use of Claude Code, with the endpoint healthy. Claude Code
> refreshes on events, not on a timer, so the file may sit unchanged for a long
> time. **The 5-minute API poll is what actually bounds staleness.**

Net effect versus the original 60-second poll: **~5× fewer requests**, with
freshness bounded by the poll rather than the watcher, and the data's age
always visible so a stale reading can't be mistaken for a current one.

---

## Reproducing these findings

```sh
# 1. Current status and headers
curl -s -D /dev/stderr -o /dev/null \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  https://api.anthropic.com/api/oauth/usage

# 2. Claude Code's cadence constants (values may change between releases)
CB=$(readlink -f ~/.local/bin/claude)
python3 - <<'PY'
import re, os, subprocess
cb = subprocess.check_output(['readlink','-f',os.path.expanduser('~/.local/bin/claude')]).decode().strip()
data = open(cb,'rb').read()
i = data.find(b'cachedUsageUtilization')
print(re.findall(rb'[\x20-\x7e]{25,}', data[i-350:i+350])[0].decode())
PY

# 3. The extension's own view of the chain (from the repo root)
gjs test/smoke-live.js
```

`smoke-live.js` prints `source`, `error`, cache age and remaining backoff — the
fastest way to tell "throttled and serving cache" apart from "offline".
