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

/* A null `previous` means nothing has been adopted yet — the first read after
 * enable(). Treating that as a switch would make every Shell restart spend a
 * redundant live request. Signing out (`current` null) is a real switch. */
var identityChanged = function (previous, current) {
    if (previous === null || previous === undefined)
        return false;
    return previous !== current;
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

function _readJson(path) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (source, result) => {
            let text = null;
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (ok)
                    text = ByteArray.toString(contents);
            } catch (e) {
                resolve(null);
                return;
            }

            try {
                resolve(text ? JSON.parse(text) : null);
            } catch (e) {
                resolve(null);
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
 * unreachable — but only when that cache belongs to the account signed in now. */
var readAccount = function () {
    const path = accountPath();

    return _readJson(path).then(data => {
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
 */
var fetchUsage = function ({
    force = false,
    cacheOnly = false,
    notOlderThanMs = 0,
} = {}) {
    return readAccount().then(account => {
        const fallback = error => {
            const nowMs = Date.now();
            const cached = parseUtilization(account.cached);
            const retryInMs = backoff.remainingMs(nowMs);

            if (cached) {
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
            if (!cached || !cacheSupersedes(account.cachedAtMs, notOlderThanMs)) {
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
