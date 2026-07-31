# Account switch detection

**Date:** 2026-07-31
**Status:** designed

## Goal

When the signed-in Claude account changes, the indicator notices within seconds
and shows the new account's usage — instead of carrying the previous account's
numbers until the next five-minute poll.

Detection is driven by the state on disk, not by the extension's own "Switch
Account" button, so a `claude auth login` run in any terminal, or `/login`
inside Claude Code, is picked up the same way.

## Why this is a correctness fix, not a convenience

`~/.claude.json` holds two things written at different times: the current
identity under `oauthAccount`, and a usage cache under `cachedUsageUtilization`
stamped with the `accountUuid` it belongs to.

`readAccount()` (`usage.js:271`) reads `cache.utilization` without checking that
stamp. Claude Code only prunes a foreign cache when *it* next reads one, so
between an account switch and Claude Code's next usage read, the file legitimately
contains the **new** account's `oauthAccount` beside the **old** account's cache.

The extension will render those old numbers under the new email, with nothing on
screen indicating they are wrong. That is worse than the reported symptom, and
has the same root cause.

## Evidence (read from the binary, not assumed)

All of the following was extracted from
`~/.local/share/claude/versions/2.1.220` (an ELF with embedded JS; `grep -a`
is required — without `-a` grep reports no matches at all).

Cache writer:

```js
let r = dc()?.accountUuid;
if (r !== t) return;                    // only write if the account is still the one fetched for
let n = xt().cachedUsageUtilization;
let o = (n && n.accountUuid === r) ? Date.now() - n.fetchedAtMs : Infinity;
if (o >= 0 && o < NZg) return;          // NZg = 300000 (5 min) — minimum rewrite interval
hr(i => ({ ...i, cachedUsageUtilization: {
    fetchedAtMs: Date.now(), accountUuid: r, utilization: e } }));
```

Cache reader:

```js
if (t.data.accountUuid !== dc()?.accountUuid) {
    hr(n => ({ ...n, cachedUsageUtilization: void 0 }));   // drops a foreign cache
    return null;
}
let r = Date.now() - t.data.fetchedAtMs;
if (r < 0 || r > $Zg) return null;      // $Zg = 3600000 (1 hour) — read expiry
```

Schema: `{ fetchedAtMs: number, accountUuid?: string, utilization: {...} }`.

On logout, `cachedUsageUtilization` is cleared in the same write that clears
`oauthAccount`, so the two never disagree in that direction.

Incidentally, this confirms `docs/anthropic-usage-endpoint.md`: the five-minute
cadence and one-hour validity that document asserts are literally `NZg` and
`$Zg`.

## Design

### Two identity keys, deliberately different

**Switch detection** uses `accountUuid` + `organizationUuid`, falling back to
`emailAddress` when the UUIDs are absent. Moving the same account between
organisations changes the applicable limits, so it counts as a switch.

**The cache guard** uses `accountUuid` alone, because that is the only field the
cache carries. The guard cannot be stricter than the data allows.

New pure functions in `usage.js`, testable under plain gjs:

```js
accountIdentity(oauthAccount) → 'uuid:orguuid' | 'email@x' | null
identityChanged(previous, current) → boolean
```

`identityChanged` returns `false` when `previous` is `null`. That case is
*adoption* — the first read after `enable()` — not a switch. Without it, every
Shell restart would fire a redundant live fetch.

### Cache guard

The decision is a third pure function, so it can be tested without touching the
filesystem:

```js
cacheBelongsTo(cache, accountUuid) → boolean
```

`readAccount()` returns `cached: null` when it says no. A cache with no
`accountUuid` at all (the field is optional in the schema) is accepted, since
there is nothing to contradict.

This stands on its own and is worth having even without the rest of the feature.

### Where the comparison happens

Today `fetchUsage({cacheOnly: true})` returns bare `{ skip: true }`. The new
identity is in the file it just read and is then discarded — which is precisely
why the switch goes unnoticed. The skip branch grows two fields:

```js
return { skip: true, identity, email };
```

One file read, one code path. `refresh()` compares before honouring `skip`:

```
watcher fires (existing 2s debounce)
  → refresh({ cacheOnly: true })
  → identityChanged(this._identity, result.identity)?
      yes → adopt the new identity
            clear the display: new email, percentages '—'
            refresh({ force: true })   ← live, necessarily
      no  → current behaviour, unchanged
```

Logout falls out of this for free: identity → `null` → clear → "No account
found".

### Clearing immediately

The panel is read at a glance from the top of the screen, and a wrong number
read at a glance is worse than an em dash. Holding the old numbers until the new
ones arrive has the bad failure mode: going offline mid-switch leaves account A
on screen while you are signed into account B, indefinitely, with no signal.

### `force: true` on the switch fetch

Same reasoning as the refresh button: an account switch is you acting, not the
traffic that earned a throttle. The backoff state itself is left alone — if the
forced request succeeds, `fetchLive` already calls `backoff.reset()`.

### The token race

`~/.claude.json` and `~/.claude/.credentials.json` are written separately. If
the new email lands first, the fetch uses the old token and gets a 401 — so the
panel would announce "Token expired" immediately after a *successful* login.

The post-switch fetch, and only it, retries on `Err.EXPIRED` on a short ladder:
2s, 5s, 10s. During that window the status row reads
`Loading usage for the new account…` rather than the error text. If all three
fail, the real error surfaces and the normal poll takes over.

Worst case is three extra requests, on an account switch, which is rare and
user-initiated. Stated explicitly because this project treats request budget as
a real constraint.

A ladder rather than a second watcher on `.credentials.json`: it self-corrects
regardless of which file is written first, and adds neither a watcher nor
in-memory token state.

## Testing

`test/run-tests.js` gains coverage for:

- `accountIdentity` — full object, missing `organizationUuid`, UUIDs absent so
  email is used, no account at all, malformed input.
- `identityChanged` — adoption from `null`, identical, different, logout
  (`X → null`).
- `cacheBelongsTo` — matching uuid accepted, mismatched uuid rejected, absent
  uuid accepted, missing cache rejected.

The wiring from watcher → indicator → fetch depends on file I/O and a running
Shell, so it stays outside the harness, as the rest of that layer already does.
Real verification is switching accounts and watching the panel.

## Out of scope

The extension does not enforce Claude Code's one-hour cache expiry (`$Zg`). It
shows the cache's age instead and lets the reader judge. Worth revisiting, but
it is a separate decision from account switching.
