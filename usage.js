/* usage.js
 *
 * Data layer for the Claude Monitor indicator.
 *
 * Deliberately free of St/Shell imports so it can be exercised under plain gjs
 * (see test/run-tests.js) without a running GNOME Shell.
 */

'use strict';

imports.gi.versions.Soup = '2.4';

const { Gio, GLib, Soup } = imports.gi;
const ByteArray = imports.byteArray;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT = 15;

/* Error codes the UI knows how to phrase. */
var Err = {
    NO_AUTH: 'no-auth',
    EXPIRED: 'expired',
    OFFLINE: 'offline',
    RATE_LIMITED: 'rate-limited',
};

/* The usage endpoint rate-limits, and unlike the Messages API it returns no
 * anthropic-ratelimit-* headers to steer by — only "retry-after: 0", which
 * carries no information. Claude Code, which owns this endpoint, protects
 * itself by cadence rather than by backoff: it refuses to refresh its cache
 * more often than every 5 minutes and treats the result as good for an hour.
 * The extension matches that cadence (see extension.js) and keeps this backoff
 * for when it gets throttled anyway. */
const BACKOFF_MIN_MS = 2 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const BACKOFF_JITTER = 0.2;

var backoff = {
    untilMs: 0,
    stepMs: 0,

    /* Injectable so tests can pin it. Anthropic's reference retry adds random
     * jitter so that clients recovering from one outage don't resynchronise
     * into the next. */
    random: Math.random,

    active(nowMs) {
        return nowMs < this.untilMs;
    },

    remainingMs(nowMs) {
        return Math.max(0, this.untilMs - nowMs);
    },

    /* Doubles per consecutive rejection. A Retry-After hint wins if it asks
     * for longer than we would have waited; this endpoint sends 0 when it has
     * no opinion, which must not shorten the wait. */
    penalise(nowMs, retryAfterSeconds) {
        const hintedMs = Math.max(0, Number(retryAfterSeconds) || 0) * 1000;

        this.stepMs = this.stepMs === 0
            ? BACKOFF_MIN_MS
            : Math.min(this.stepMs * 2, BACKOFF_MAX_MS);

        const jitteredMs = this.stepMs * (1 + BACKOFF_JITTER * this.random());
        this.untilMs = nowMs + Math.max(jitteredMs, hintedMs);
    },

    reset() {
        this.untilMs = 0;
        this.stepMs = 0;
    },
};

/* ~/.claude.json and ~/.claude/.credentials.json are written separately, so a
 * login can present a new email alongside a token that has not been written
 * yet. Worst case three extra requests, only ever on a switch. */
var SWITCH_RETRY_DELAYS_MS = [2000, 5000, 10000];

/* How long to wait before retrying a post-switch fetch, or null to stop.
 *
 * A 401 in the write-race window is not an expired token, and a missing
 * credentials file is not a signed-out user — both are a file that has not
 * landed yet, and reporting either as a fault right after a successful login
 * is worse than saying nothing.
 *
 * `identity` is the account the switch moved *to*. When it is null the user
 * genuinely signed out: there is no token by definition, so "not signed in" is
 * the truth and must be shown immediately rather than retried. When it is
 * undefined the account file could not be read (see readAccount), and inside
 * this window that is most likely the very write race the ladder exists for —
 * so it keeps waiting rather than reporting a successful login as a fault.
 * Either way the ladder is bounded, so a genuinely unreadable file costs three
 * attempts and then says what it found.
 *
 * Lives here rather than in indicator.js so the harness can cover exhaustion
 * and the non-retryable errors — indicator.js needs St and a running Shell. */
var switchRetryDelayMs = function (error, attempt, identity) {
    if (identity === null)
        return null;
    if (error !== Err.EXPIRED && error !== Err.NO_AUTH)
        return null;
    if (!Number.isInteger(attempt) || attempt < 0)
        return null;
    if (attempt >= SWITCH_RETRY_DELAYS_MS.length)
        return null;

    return SWITCH_RETRY_DELAYS_MS[attempt];
};

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/* Thresholds are exclusive: 90 is still "warn", 91 is "crit". */
var severityClass = function (percent) {
    if (!Number.isFinite(percent))
        return 'none';
    if (percent > 90)
        return 'crit';
    if (percent > 60)
        return 'warn';
    if (percent > 30)
        return 'mid';
    return 'ok';
};

/* Reduces the signed-in account to one comparable string.
 *
 * Claude Code keys its own usage cache on `accountUuid` alone. This is
 * deliberately stricter: the same account moved between organisations gets
 * different limits, so the organisation belongs in the identity. The email
 * fallback exists for accounts whose profile has not been fetched yet. */
var accountIdentity = function (oauthAccount) {
    if (!oauthAccount || typeof oauthAccount !== 'object')
        return null;

    const uuid = oauthAccount.accountUuid;
    if (typeof uuid === 'string' && uuid) {
        const org = typeof oauthAccount.organizationUuid === 'string'
            ? oauthAccount.organizationUuid
            : '';
        return `${uuid}:${org}`;
    }

    const email = oauthAccount.emailAddress;
    return typeof email === 'string' && email ? email : null;
};

/* What a freshly read identity means for what is currently on screen:
 *
 *   'unknown' — the account file could not be read; decide nothing
 *   'adopt'   — nothing on screen yet; take this identity and render normally
 *   'same'    — unchanged; carry on
 *   'switch'  — the account changed; clear and refetch
 *
 * `hasAdopted` is separate from `adopted` because null is a legitimate adopted
 * value: it is the signed-out state. Conflating "nothing adopted yet" with
 * "adopted null" meant a logout made the following login read as a first-ever
 * read, and it went unnoticed until the next poll.
 *
 * This decision lives here rather than in indicator.js so it can be tested
 * under plain gjs — indicator.js needs St and a running Shell. */
var identityTransition = function (hasAdopted, adopted, current) {
    /* undefined means the account file could not be read — no information,
     * which is not the same as being signed out. Reading a torn or unreadable
     * file as a sign-out cost a spurious clear plus a forced request, and
     * poisoned the adopted value so the next good read spent another one. */
    if (current === undefined)
        return 'unknown';

    if (!hasAdopted)
        return 'adopt';
    if (adopted === current)
        return 'same';
    return 'switch';
};

/* Whether a cached utilization block belongs to the account currently signed
 * in. The cache carries only `accountUuid`, so this cannot be as strict as
 * accountIdentity, which also pins the organisation — a guard cannot be
 * stricter than the data it has. An unstamped cache is accepted because the
 * field is optional in Claude Code's schema and there is nothing to
 * contradict; a stamped one with no account to compare against is not. */
var cacheBelongsTo = function (cache, accountUuid) {
    if (!cache || typeof cache !== 'object')
        return false;

    const stamp = cache.accountUuid;
    if (typeof stamp !== 'string' || !stamp)
        return true;

    return stamp === accountUuid;
};

function _slot(entry) {
    if (!entry)
        return null;

    const percent = Number(entry.percent !== undefined ? entry.percent : entry.utilization);
    if (!Number.isFinite(percent))
        return null;

    return {
        percent: Math.round(percent),
        resetsAt: entry.resets_at || null,
    };
}

function _findLimit(limits, predicate) {
    if (!Array.isArray(limits))
        return null;

    for (const entry of limits) {
        if (entry && predicate(entry))
            return entry;
    }
    return null;
}

function _isFableScope(entry) {
    const model = entry.scope && entry.scope.model;
    if (!model || !model.display_name)
        return false;
    return String(model.display_name).toLowerCase() === 'fable';
}

/* Accepts either the live API response or the `utilization` object cached in
 * ~/.claude.json — both carry the same inner shape. Falls back to the
 * top-level five_hour/seven_day keys if `limits` is missing. */
var parseUtilization = function (payload) {
    if (!payload || typeof payload !== 'object')
        return null;

    let session = _slot(_findLimit(payload.limits, e => e.kind === 'session'));
    let weekAll = _slot(_findLimit(payload.limits, e => e.kind === 'weekly_all'));
    const weekFable = _slot(_findLimit(payload.limits,
        e => e.kind === 'weekly_scoped' && _isFableScope(e)));

    if (!session)
        session = _slot(payload.five_hour);
    if (!weekAll)
        weekAll = _slot(payload.seven_day);

    if (!session && !weekAll)
        return null;

    return { session, weekAll, weekFable };
};

/* The API emits microsecond precision ("...:00.479416+00:00"), which is more
 * fractional digits than Date.parse is specified to accept. */
var formatResetIn = function (isoString, nowMs) {
    if (!isoString)
        return null;

    const then = Date.parse(String(isoString).replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isFinite(then))
        return null;

    let minutes = Math.round((then - nowMs) / 60000);
    if (minutes <= 0)
        return 'now';

    const days = Math.floor(minutes / 1440);
    minutes -= days * 1440;
    const hours = Math.floor(minutes / 60);
    minutes -= hours * 60;

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
};

/* Claude Code rewrites ~/.claude.json for many reasons that have nothing to do
 * with usage — session counters, tip history, prompt queue. A watcher event
 * therefore does NOT mean the cached utilization changed, and rendering it
 * unconditionally will overwrite fresher live data with an older reading.
 * Only a strictly newer cache may replace what is already on screen. */
var cacheSupersedes = function (cachedAtMs, displayedAtMs) {
    const cached = Number(cachedAtMs);
    if (!Number.isFinite(cached) || cached <= 0)
        return false;

    const displayed = Number(displayedAtMs);
    return cached > (Number.isFinite(displayed) ? displayed : 0);
};

/* The oldest a cache may be and still be worth rendering, from the two
 * independent floors a caller has:
 *
 *   `displayedAtMs` — what is already on screen. A cache must be strictly
 *     newer to replace it (see cacheSupersedes).
 *
 *   `switchedAtMs` — when the account last changed. accountIdentity pins the
 *     organisation deliberately, because the same account moved between
 *     organisations gets different limits; cacheBelongsTo structurally cannot,
 *     because the cache carries only an accountUuid. So on an org move the
 *     cache is not disowned, and after the panel clears there is nothing on
 *     screen to outrank it — the previous organisation's numbers render under
 *     the new one's name. A switch therefore refuses everything written before
 *     it outright. Switching back to an account whose cache is still on disk
 *     loses that shortcut, which is the safe direction to be wrong in.
 */
var cacheFloor = function (displayedAtMs, switchedAtMs) {
    const displayed = Number(displayedAtMs);
    const switched = Number(switchedAtMs);

    return Math.max(
        Number.isFinite(displayed) && displayed > 0 ? displayed : 0,
        Number.isFinite(switched) && switched > 0 ? switched : 0);
};

/* Whether an in-flight refresh has been overtaken and must not render.
 *
 * The two counters are not interchangeable, and collapsing them into one is
 * what made the panel go quietly stale. A cache-only read resolves to nothing
 * to render whenever the cache is no fresher than what is on screen — which is
 * most of the time, since the file watcher fires one on every write to
 * ~/.claude.json and most of those have nothing to do with usage. Letting one
 * cancel a live fetch therefore threw away the only result that would have
 * rendered, and rendered nothing in its place: the panel then held the same
 * numbers for a whole poll interval with no error and no request in flight,
 * which is indistinguishable from the extension having died. This is the
 * ordinary path's version of the hazard `_switchGeneration` already exists for.
 *
 * So `live` counts only the refreshes that reach the API, and a live fetch
 * guards on that. The asymmetry runs one way only: a cache-only read still has
 * to be cancellable by a live one, because it captured `notOlderThanMs` when it
 * started and that floor goes stale the moment fresher numbers land — without
 * that, a late cache read could render older numbers over newer ones, which is
 * the bug cacheSupersedes exists to prevent.
 *
 * Lives here rather than in indicator.js so the harness can cover it —
 * indicator.js needs St and a running Shell. */
var refreshSuperseded = function (cacheOnly, started, current) {
    if (!started || !current)
        return false;

    return cacheOnly
        ? started.all !== current.all
        : started.live !== current.live;
};

var formatAge = function (ageMs) {
    const minutes = Math.floor(ageMs / 60000);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
};

/* ------------------------------------------------------------------ *
 * File access
 * ------------------------------------------------------------------ */

/* Reads a JSON file, keeping "not there" and "could not be read" apart:
 *
 *   the parsed value — the file was read and parsed
 *   null             — the file is genuinely absent (Gio's NOT_FOUND). For
 *                      ~/.claude.json that is a real signed-out state.
 *   undefined        — no information. Any other load error, or contents that
 *                      did not parse: a permission problem, a truncated read,
 *                      a half-written file.
 *
 * The distinction matters because identity now drives control flow. Claude
 * Code 2.1.220 writes ~/.claude.json atomically (temp + fchmod + fsync +
 * rename), but it also has a documented non-atomic fallback path, and reading
 * a torn file as a sign-out is a silent, self-amplifying failure — see
 * readAccount. */
function _readJson(path) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (source, result) => {
            let text = null;
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok) {
                    resolve(undefined);
                    return;
                }
                text = ByteArray.toString(contents);
            } catch (e) {
                const absent = typeof e.matches === 'function' &&
                    e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
                resolve(absent ? null : undefined);
                return;
            }

            try {
                /* An empty file is a write in progress, not an empty document. */
                resolve(text ? JSON.parse(text) : undefined);
            } catch (e) {
                resolve(undefined);
            }
        });
    });
}

function accountPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']);
}

/* Claude Code rewrites ~/.claude.json whenever it refreshes its usage cache,
 * so watching the file gives a near-instant update during active use at no API
 * cost. The same file carries plenty of unrelated state that changes often,
 * hence the debounce. */
var watchAccount = function (onChanged, debounceMs = 2000) {
    let monitor = null;
    let pendingId = 0;

    try {
        monitor = Gio.File.new_for_path(accountPath())
            .monitor_file(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        logError(e, 'claude-monitor: could not watch ~/.claude.json');
        return { cancel() {} };
    }

    monitor.connect('changed', () => {
        if (pendingId)
            GLib.Source.remove(pendingId);

        pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
            pendingId = 0;
            onChanged();
            return GLib.SOURCE_REMOVE;
        });
    });

    return {
        cancel() {
            if (pendingId) {
                GLib.Source.remove(pendingId);
                pendingId = 0;
            }
            monitor.cancel();
        },
    };
};

/* One read of ~/.claude.json yields the signed-in email, an identity to compare
 * against later reads, and the cache we fall back to when the API is
 * unreachable — but only when that cache belongs to the account signed in now.
 *
 * `identity` is `undefined` when the file could not be read at all, and `null`
 * when it is genuinely absent or carries no oauthAccount. Reading the first as
 * the second cost a spurious panel clear plus a forced request, poisoned the
 * adopted identity so the next good read spent another one, and inside a
 * post-switch retry ladder reported a successful login as a dead token. */
var readAccount = function () {
    const path = accountPath();

    return _readJson(path).then(data => {
        if (data === undefined)
            return { email: null, identity: undefined, cached: null, cachedAtMs: 0 };

        const empty = { email: null, identity: null, cached: null, cachedAtMs: 0 };
        if (!data)
            return empty;

        const account = data.oauthAccount || {};
        const cache = data.cachedUsageUtilization || null;
        const ours = cacheBelongsTo(cache, account.accountUuid);

        return {
            email: account.emailAddress || null,
            identity: accountIdentity(data.oauthAccount),
            cached: ours ? cache.utilization || null : null,
            cachedAtMs: ours ? Number(cache.fetchedAtMs) || 0 : 0,
        };
    });
};

var readToken = function () {
    const path = GLib.build_filenamev([
        GLib.get_home_dir(), '.claude', '.credentials.json',
    ]);

    return _readJson(path).then(data => {
        const oauth = data && data.claudeAiOauth;
        if (!oauth || !oauth.accessToken)
            return null;
        return oauth.accessToken;
    });
};

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

let _session = null;

function _httpSession() {
    if (_session === null) {
        _session = new Soup.Session();
        _session.timeout = REQUEST_TIMEOUT;
        _session.user_agent = 'claude-monitor-gnome-shell';
    }
    return _session;
}

var closeSession = function () {
    if (_session !== null) {
        _session.abort();
        _session = null;
    }
};

var fetchLive = function (token) {
    return new Promise(resolve => {
        const message = Soup.Message.new('GET', USAGE_URL);
        if (!message) {
            resolve({ error: Err.OFFLINE });
            return;
        }

        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        message.request_headers.append('Accept', 'application/json');

        _httpSession().queue_message(message, (_session_, msg) => {
            const status = msg.status_code;

            if (status === 401 || status === 403) {
                resolve({ error: Err.EXPIRED });
                return;
            }
            if (status === 429) {
                let retryAfter = null;
                try {
                    retryAfter = msg.response_headers.get_one('retry-after');
                } catch (e) {
                    retryAfter = null;
                }
                backoff.penalise(Date.now(), retryAfter);
                resolve({ error: Err.RATE_LIMITED });
                return;
            }
            /* A 5xx is the server in distress — the same "slow down" signal a
             * 429 carries, so it earns the same backoff. Network failures do
             * not: nothing server-side is struggling. */
            if (status >= 500) {
                backoff.penalise(Date.now(), null);
                resolve({ error: Err.OFFLINE });
                return;
            }
            if (status !== 200) {
                resolve({ error: Err.OFFLINE });
                return;
            }

            backoff.reset();

            let payload = null;
            try {
                payload = JSON.parse(msg.response_body.data);
            } catch (e) {
                resolve({ error: Err.OFFLINE });
                return;
            }

            const usage = parseUtilization(payload);
            resolve(usage ? { usage } : { error: Err.OFFLINE });
        });
    });
};

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/* Resolves to:
 *   { email, identity, usage: {session, weekAll, weekFable} | null,
 *     source: 'live' | 'cache' | null, ageMs, retryInMs,
 *     error: null | Err.* }
 *
 * or, when a cache-only read has nothing worth rendering:
 *   { skip: true, identity, email }
 *
 * `identity` is on both shapes deliberately. A fresh login arrives as exactly
 * the second one — new identity, no usable cache — so a caller that only reads
 * identity off the rendering shape would never see the switch.
 *
 * Never rejects — the indicator always gets something to render.
 *
 * `force` skips an active rate-limit backoff. Reserved for the refresh button:
 * a person clicking it is not the traffic that got us throttled, and an
 * unresponsive button reads as broken.
 *
 * `cacheOnly` reads the file and stops — no token, no request. Used by the
 * file watcher, where hitting the API would be both redundant and a step
 * toward being throttled.
 *
 * `notOlderThanMs` is the timestamp of whatever is already on screen. A
 * cache-only read resolves to `{skip: true}` unless the cache is strictly
 * newer, so a watcher event can neither blank out nor stale-overwrite good
 * live data. Callers that render must pass it.
 *
 * `cacheFloorMs` is when the account last changed, and it is a harder floor:
 * it applies to the offline fallback too, where `notOlderThanMs` deliberately
 * does not. Falling back to an older cache is the normal path when the API is
 * unreachable, but falling back to one from *before* an account switch means
 * rendering another account's numbers — see cacheFloor.
 */
var fetchUsage = function ({
    force = false,
    cacheOnly = false,
    notOlderThanMs = 0,
    cacheFloorMs = 0,
} = {}) {
    return readAccount().then(account => {
        const fallback = error => {
            const nowMs = Date.now();
            const cached = parseUtilization(account.cached);
            const retryInMs = backoff.remainingMs(nowMs);

            /* Only the switch floor, not notOlderThanMs: serving a cache older
             * than what is on screen is exactly what this path is *for* when
             * the API is unreachable. Serving one from before an account
             * switch is not — that reached straight past the panel clear and
             * rendered the previous organisation's numbers, because the cache
             * carries no organizationUuid for cacheBelongsTo to reject. */
            if (cached && cacheSupersedes(account.cachedAtMs, cacheFloorMs)) {
                return {
                    email: account.email,
                    identity: account.identity,
                    usage: cached,
                    source: 'cache',
                    ageMs: Math.max(0, nowMs - account.cachedAtMs),
                    retryInMs,
                    error,
                };
            }
            return {
                email: account.email,
                identity: account.identity,
                usage: null,
                source: null,
                ageMs: 0,
                retryInMs,
                error: error || Err.NO_AUTH,
            };
        };

        if (cacheOnly) {
            const cached = parseUtilization(account.cached);
            const floorMs = cacheFloor(notOlderThanMs, cacheFloorMs);
            if (!cached || !cacheSupersedes(account.cachedAtMs, floorMs)) {
                /* Nothing to render — but the identity still travels, because
                 * this is the shape a fresh login arrives in. */
                return {
                    skip: true,
                    identity: account.identity,
                    email: account.email,
                };
            }

            const nowMs = Date.now();
            return {
                email: account.email,
                identity: account.identity,
                usage: cached,
                source: 'cache',
                ageMs: Math.max(0, nowMs - account.cachedAtMs),
                retryInMs: backoff.remainingMs(nowMs),
                error: null,
            };
        }

        if (!force && backoff.active(Date.now()))
            return fallback(Err.RATE_LIMITED);

        return readToken().then(token => {
            if (!token)
                return fallback(Err.NO_AUTH);

            return fetchLive(token).then(result => {
                if (result.error)
                    return fallback(result.error);

                return {
                    email: account.email,
                    identity: account.identity,
                    usage: result.usage,
                    source: 'live',
                    ageMs: 0,
                    retryInMs: 0,
                    error: null,
                };
            });
        });
    });
};
