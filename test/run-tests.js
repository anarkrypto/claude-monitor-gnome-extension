#!/usr/bin/env gjs
/* run-tests.js — exercises the pure half of usage.js outside GNOME Shell.
 *
 *   cd claude-monitor-gnome-extension && gjs test/run-tests.js
 */

'use strict';

const { Gio, GLib } = imports.gi;

imports.searchPath.unshift(GLib.get_current_dir());

const Usage = imports.usage;
const Fixtures = imports.test.fixtures;

let passed = 0;
const failures = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
    }
}

/* --- parseUtilization: live response ------------------------------- */

const live = Usage.parseUtilization(Fixtures.LIVE_RESPONSE);
check('live: session percent', live.session.percent, 49);
check('live: weekAll percent', live.weekAll.percent, 75);
check('live: weekFable percent', live.weekFable.percent, 0);
check('live: session resets_at carried through',
    live.session.resetsAt, '2026-07-31T05:29:59.333076+00:00');
check('live: fable has no reset time', live.weekFable.resetsAt, null);

/* --- parseUtilization: cached object ------------------------------- */

const cached = Usage.parseUtilization(Fixtures.CACHED_UTILIZATION);
check('cache: session percent', cached.session.percent, 48);
check('cache: weekAll percent', cached.weekAll.percent, 75);
check('cache: weekFable percent', cached.weekFable.percent, 0);

/* --- parseUtilization: degraded inputs ----------------------------- */

const legacy = Usage.parseUtilization(Fixtures.LEGACY_RESPONSE);
check('legacy: falls back to five_hour', legacy.session.percent, 12);
check('legacy: falls back to seven_day', legacy.weekAll.percent, 34);
check('legacy: no fable slot', legacy.weekFable, null);

const noFable = Usage.parseUtilization(Fixtures.NO_FABLE_RESPONSE);
check('no-fable: session still parsed', noFable.session.percent, 5);
check('no-fable: fable is null', noFable.weekFable, null);

check('null payload', Usage.parseUtilization(null), null);
check('undefined payload', Usage.parseUtilization(undefined), null);
check('string payload', Usage.parseUtilization('nope'), null);
check('empty object', Usage.parseUtilization({}), null);
check('empty limits array', Usage.parseUtilization({ limits: [] }), null);
check('unparseable percent', Usage.parseUtilization({
    limits: [{ kind: 'session', percent: 'abc' }],
}), null);

/* Fractional percents are rounded so the panel never shows "48.6%". */
check('fractional percent rounds', Usage.parseUtilization({
    limits: [{ kind: 'session', percent: 48.6, resets_at: null, scope: null }],
}).session.percent, 49);

/* Fable is matched case-insensitively — display_name casing is not ours. */
check('fable match is case-insensitive', Usage.parseUtilization({
    limits: [
        { kind: 'session', percent: 1, scope: null },
        { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'FABLE' } } },
    ],
}).weekFable.percent, 7);

/* A scoped limit for some other model must not be mistaken for Fable. */
check('other scoped model is not fable', Usage.parseUtilization({
    limits: [
        { kind: 'session', percent: 1, scope: null },
        { kind: 'weekly_scoped', percent: 7, scope: { model: { display_name: 'Opus' } } },
    ],
}).weekFable, null);

/* --- severityClass -------------------------------------------------- */

check('severity 0', Usage.severityClass(0), 'ok');
check('severity 30 (boundary, not exceeded)', Usage.severityClass(30), 'ok');
check('severity 31', Usage.severityClass(31), 'mid');
check('severity 60 (boundary, not exceeded)', Usage.severityClass(60), 'mid');
check('severity 61', Usage.severityClass(61), 'warn');
check('severity 90 (boundary, not exceeded)', Usage.severityClass(90), 'warn');
check('severity 91', Usage.severityClass(91), 'crit');
check('severity 100', Usage.severityClass(100), 'crit');
check('severity NaN', Usage.severityClass(NaN), 'none');
check('severity undefined', Usage.severityClass(undefined), 'none');

/* --- formatResetIn -------------------------------------------------- */

const NOW = Date.parse('2026-07-30T22:30:00.000Z');

check('reset: microsecond precision parses',
    Usage.formatResetIn('2026-07-31T05:30:00.479416+00:00', NOW), '7h 0m');
check('reset: minutes only',
    Usage.formatResetIn('2026-07-30T22:45:00+00:00', NOW), '15m');
check('reset: hours and minutes',
    Usage.formatResetIn('2026-07-31T01:12:00+00:00', NOW), '2h 42m');
check('reset: days and hours',
    Usage.formatResetIn('2026-08-02T04:30:00+00:00', NOW), '2d 6h');
check('reset: already elapsed', Usage.formatResetIn('2026-07-30T20:00:00+00:00', NOW), 'now');
check('reset: null input', Usage.formatResetIn(null, NOW), null);
check('reset: garbage input', Usage.formatResetIn('not-a-date', NOW), null);

/* --- formatAge ------------------------------------------------------ */

check('age: under a minute', Usage.formatAge(30 * 1000), 'just now');
check('age: minutes', Usage.formatAge(5 * 60 * 1000), '5m ago');
check('age: hours', Usage.formatAge(3 * 3600 * 1000), '3h ago');
check('age: days', Usage.formatAge(50 * 3600 * 1000), '2d ago');

/* --- cache must never overwrite fresher data -------------------------- */

/* Regression: the file watcher fires on ANY write to ~/.claude.json, and
 * Claude Code writes it for reasons unrelated to usage (measured: one write in
 * 30s with the usage cache unchanged). Rendering the cache unconditionally
 * replaced a just-fetched live value with a 45-minute-old one — the panel
 * "fixed itself" on refresh, then reverted a few seconds later. */

const T_NOW = Date.parse('2026-07-31T02:00:00Z');
const T_OLD = T_NOW - 45 * 60 * 1000;

check('cache: older cache never replaces fresher live data',
    Usage.cacheSupersedes(T_OLD, T_NOW), false);
check('cache: newer cache does replace what is displayed',
    Usage.cacheSupersedes(T_NOW, T_OLD), true);
check('cache: an identical timestamp is not an update',
    Usage.cacheSupersedes(T_NOW, T_NOW), false);
check('cache: renders when nothing is displayed yet',
    Usage.cacheSupersedes(T_NOW, 0), true);
check('cache: a cache of unknown age never wins',
    Usage.cacheSupersedes(0, 0), false);
check('cache: a missing timestamp never wins',
    Usage.cacheSupersedes(undefined, 0), false);
check('cache: a garbage timestamp never wins',
    Usage.cacheSupersedes('nope', 0), false);
check('cache: a garbage displayed timestamp is treated as nothing displayed',
    Usage.cacheSupersedes(T_NOW, 'nope'), true);

/* --- a cache-only read may not cancel a live fetch --------------------- */

/* Regression: every refresh bumped one shared generation counter, and a
 * result whose generation had moved on was dropped without rendering. A
 * cache-only read resolves to nothing to render whenever the cache is no
 * fresher than the panel — which is most of the time — so when one landed
 * during a live poll it cancelled it and rendered nothing itself. The panel
 * then sat unchanged for a whole poll interval with no error and no request in
 * flight, which reads exactly like the extension having quietly died.
 *
 * The file watcher fires a cache-only read on every write to ~/.claude.json
 * (measured: every 30-90s during active use, and every few seconds in a
 * burst), against a live poll whose window was measured at 0.33-0.49s warm and
 * 2.27s on a cold connection. This is the ordinary path's version of the
 * hazard `_switchGeneration` already exists for. */

const GEN = { all: 7, live: 3 };

check('guard: a live fetch survives a cache-only read starting after it',
    Usage.refreshSuperseded(false, GEN, { all: 9, live: 3 }), false);
check('guard: a live fetch is cancelled by a newer live fetch',
    Usage.refreshSuperseded(false, GEN, { all: 9, live: 4 }), true);
check('guard: an unovertaken live fetch renders',
    Usage.refreshSuperseded(false, GEN, GEN), false);

/* The asymmetry runs one way only. A cache-only read captured notOlderThanMs
 * when it started, so fresher numbers landing since make its floor stale. */
check('guard: a cache-only read is cancelled by a live fetch',
    Usage.refreshSuperseded(true, GEN, { all: 8, live: 4 }), true);
check('guard: a cache-only read is cancelled by a newer cache-only read',
    Usage.refreshSuperseded(true, GEN, { all: 8, live: 3 }), true);
check('guard: an unovertaken cache-only read renders',
    Usage.refreshSuperseded(true, GEN, GEN), false);

/* --- a switch is a floor no cache may be served from under ------------ */

/* accountIdentity pins the organisation on purpose — the same account moved
 * between organisations gets different limits. cacheBelongsTo structurally
 * cannot: the cache carries only an accountUuid. So on an org move the cache
 * is not disowned, the panel clears, nothing is left on screen to outrank it,
 * and the previous organisation's numbers render under the new one's name.
 * The switch's own timestamp is the missing floor. */

const T_SWITCH = T_NOW - 5 * 60 * 1000;

check('floor: a switch outranks an empty screen',
    Usage.cacheFloor(0, T_SWITCH), T_SWITCH);
check('floor: fresher displayed data outranks an older switch',
    Usage.cacheFloor(T_NOW, T_SWITCH), T_NOW);
check('floor: a switch outranks older displayed data',
    Usage.cacheFloor(T_OLD, T_SWITCH), T_SWITCH);
check('floor: with no switch yet, only what is displayed counts',
    Usage.cacheFloor(T_NOW, 0), T_NOW);
check('floor: nothing displayed and no switch imposes no floor',
    Usage.cacheFloor(0, 0), 0);
/* _dataTimestampMs is null until the first render, and the fields are passed
 * straight through — a floor must never come back NaN, which every comparison
 * would then answer false to. */
check('floor: a null displayed timestamp is no floor',
    Usage.cacheFloor(null, T_SWITCH), T_SWITCH);
check('floor: garbage on either side is no floor',
    Usage.cacheFloor('nope', undefined), 0);
check('floor: a negative timestamp is no floor',
    Usage.cacheFloor(-1, 0), 0);

/* The floor is only useful because cacheSupersedes then refuses the cache. */
check('floor: a pre-switch cache is refused',
    Usage.cacheSupersedes(T_OLD, Usage.cacheFloor(0, T_SWITCH)), false);
check('floor: a cache written after the switch is served',
    Usage.cacheSupersedes(T_NOW, Usage.cacheFloor(0, T_SWITCH)), true);

/* --- account identity ------------------------------------------------ */

/* The organisation is part of the identity: the same account moved between
 * organisations is subject to different limits, so it must read as a switch. */
check('identity: uuid and org',
    Usage.accountIdentity({ accountUuid: 'a1', organizationUuid: 'o1' }), 'a1:o1');
check('identity: org missing still yields an identity',
    Usage.accountIdentity({ accountUuid: 'a1' }), 'a1:');
check('identity: uuid absent falls back to email',
    Usage.accountIdentity({ emailAddress: 'x@y.z' }), 'x@y.z');
check('identity: uuid wins over email',
    Usage.accountIdentity({ accountUuid: 'a1', emailAddress: 'x@y.z' }), 'a1:');
check('identity: empty object', Usage.accountIdentity({}), null);
check('identity: null', Usage.accountIdentity(null), null);
check('identity: undefined', Usage.accountIdentity(undefined), null);
check('identity: string input', Usage.accountIdentity('nope'), null);
check('identity: non-string uuid is ignored',
    Usage.accountIdentity({ accountUuid: 42, emailAddress: 'x@y.z' }), 'x@y.z');
check('identity: empty uuid is ignored',
    Usage.accountIdentity({ accountUuid: '', emailAddress: 'x@y.z' }), 'x@y.z');
/* The two forms can never collide: the uuid form always carries a colon and an
 * email address never does. */
check('identity: email form has no colon',
    Usage.accountIdentity({ emailAddress: 'x@y.z' }).includes(':'), false);

/* --- switch detection ------------------------------------------------- */

/* Nothing adopted yet is the first read after enable(). Treating it as a
 * switch would make every Shell restart spend a redundant live request. */
check('transition: nothing adopted yet',
    Usage.identityTransition(false, null, 'a1:o1'), 'adopt');
check('transition: nothing adopted, and still signed out',
    Usage.identityTransition(false, null, null), 'adopt');
check('transition: identical', Usage.identityTransition(true, 'a1:o1', 'a1:o1'), 'same');
check('transition: a different account',
    Usage.identityTransition(true, 'a1:o1', 'a2:o1'), 'switch');
check('transition: the same account in another org',
    Usage.identityTransition(true, 'a1:o1', 'a1:o2'), 'switch');
check('transition: logout', Usage.identityTransition(true, 'a1:o1', null), 'switch');
/* Regression: signing out and back in is an ordinary way to change accounts.
 * While null doubled as "nothing adopted", this read as a first-ever read and
 * the login went unnoticed until the next poll. */
check('transition: signing in from a signed-out state',
    Usage.identityTransition(true, null, 'a2:o2'), 'switch');
check('transition: still signed out',
    Usage.identityTransition(true, null, null), 'same');

/* Regression: ~/.claude.json failing to read — a torn write, a permission
 * problem — resolved the same identity a genuine sign-out does. Since identity
 * drives control flow, that cost a spurious panel clear plus a forced request,
 * and poisoned the adopted value so the next good read spent another one. */
check('transition: an unreadable account file decides nothing',
    Usage.identityTransition(true, 'a1:o1', undefined), 'unknown');
/* Ahead of the hasAdopted rule on purpose: an unreadable file at startup is
 * not "nothing on screen yet", it is nothing known — adopting undefined would
 * make the first good read look like a switch. */
check('transition: unreadable before anything was adopted',
    Usage.identityTransition(false, null, undefined), 'unknown');
check('transition: unreadable while signed out',
    Usage.identityTransition(true, null, undefined), 'unknown');
/* The distinction this rule exists for: same call site, different meaning. */
check('transition: a genuine logout is still a switch',
    Usage.identityTransition(true, 'a1:o1', null), 'switch');

/* --- post-switch retry ladder ------------------------------------------ */

/* ~/.claude.json and ~/.claude/.credentials.json are written separately, so a
 * login can present a new email alongside a token that has not landed yet.
 * switchRetryDelayMs is the decision the ladder in indicator.js runs on —
 * covered here so exhaustion and the non-retryable errors are assertions
 * rather than paths only a manual account switch could reach. */

const SWITCHED_TO = 'a1:o1';

check('ladder: first delay',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 0, SWITCHED_TO), 2000);
check('ladder: second delay',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 1, SWITCHED_TO), 5000);
check('ladder: third delay',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 2, SWITCHED_TO), 10000);
/* Three attempts is the whole ladder — the fourth failure has to be shown. */
check('ladder: exhausted after the third attempt',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 3, SWITCHED_TO), null);

/* The credentials file lags independently of ~/.claude.json, so a login can
 * briefly present no token at all rather than a stale one — NO_AUTH earns the
 * same ladder as EXPIRED. */
check('ladder: NO_AUTH retried like EXPIRED',
    Usage.switchRetryDelayMs(Usage.Err.NO_AUTH, 0, SWITCHED_TO), 2000);
check('ladder: NO_AUTH also exhausts at the same point',
    Usage.switchRetryDelayMs(Usage.Err.NO_AUTH, 3, SWITCHED_TO), null);

/* A null identity is a genuine sign-out, not a write race — there is no token
 * by definition, so both errors must be shown immediately rather than
 * retried. */
check('ladder: null identity refuses to retry EXPIRED',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 0, null), null);
check('ladder: null identity refuses to retry NO_AUTH',
    Usage.switchRetryDelayMs(Usage.Err.NO_AUTH, 0, null), null);

/* An undefined identity is ~/.claude.json failing to read, which in this
 * window is most likely the same half-written file the ladder exists for.
 * Regression: it used to share the sign-out branch, so an unreadable file
 * landing mid-ladder ended it and reported a successful login as a dead
 * token. The ladder is bounded, so a genuinely unreadable file still gets
 * answered — three attempts later. */
check('ladder: an unreadable account file keeps waiting on EXPIRED',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 0, undefined), 2000);
check('ladder: an unreadable account file keeps waiting on NO_AUTH',
    Usage.switchRetryDelayMs(Usage.Err.NO_AUTH, 1, undefined), 5000);
check('ladder: an unreadable account file still exhausts',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 3, undefined), null);
check('ladder: an unreadable account file does not retry OFFLINE',
    Usage.switchRetryDelayMs(Usage.Err.OFFLINE, 0, undefined), null);

/* Neither is a symptom of the write race, so retrying them would just delay
 * an unrelated, already-accurate fault message. */
check('ladder: OFFLINE is not retried',
    Usage.switchRetryDelayMs(Usage.Err.OFFLINE, 0, SWITCHED_TO), null);
check('ladder: RATE_LIMITED is not retried',
    Usage.switchRetryDelayMs(Usage.Err.RATE_LIMITED, 0, SWITCHED_TO), null);

/* Success has nothing to retry. */
check('ladder: no error is not retried',
    Usage.switchRetryDelayMs(null, 0, SWITCHED_TO), null);

/* Malformed attempt counters must fail closed rather than index the array
 * with something that is not a valid index. */
check('ladder: a negative attempt is not retried',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, -1, SWITCHED_TO), null);
check('ladder: a non-integer attempt is not retried',
    Usage.switchRetryDelayMs(Usage.Err.EXPIRED, 1.5, SWITCHED_TO), null);

/* --- cache ownership --------------------------------------------------- */

/* Claude Code stamps its usage cache with the accountUuid it belongs to, and
 * only prunes a foreign one when Claude Code itself next reads it. Between an
 * account switch and that read, ~/.claude.json holds the new account's identity
 * beside the old account's usage — so the guard has to be ours as well. */
check('owner: matching uuid is ours',
    Usage.cacheBelongsTo({ accountUuid: 'a1' }, 'a1'), true);
check('owner: a foreign uuid is not',
    Usage.cacheBelongsTo({ accountUuid: 'a1' }, 'a2'), false);
/* accountUuid is optional in Claude Code's schema — an unstamped cache has
 * nothing to contradict. */
check('owner: no uuid on the cache has nothing to contradict',
    Usage.cacheBelongsTo({ fetchedAtMs: 1 }, 'a1'), true);
check('owner: an empty uuid is treated as absent',
    Usage.cacheBelongsTo({ accountUuid: '' }, 'a1'), true);
/* Signed out with a stamped cache left behind: serving it would attribute
 * someone's usage to "No account found". */
check('owner: a stamped cache with no account to compare is foreign',
    Usage.cacheBelongsTo({ accountUuid: 'a1' }, undefined), false);
check('owner: missing cache', Usage.cacheBelongsTo(null, 'a1'), false);
check('owner: garbage cache', Usage.cacheBelongsTo('nope', 'a1'), false);

/* --- rate-limit backoff ---------------------------------------------- */

const MIN = 60 * 1000;
const T0 = Date.parse('2026-07-31T00:00:00Z');

/* Pin the jitter so the ladder is assertable; range is checked separately. */
Usage.backoff.random = () => 0;

Usage.backoff.reset();
check('backoff: idle by default', Usage.backoff.active(T0), false);
check('backoff: nothing to wait for when idle', Usage.backoff.remainingMs(T0), 0);

Usage.backoff.penalise(T0, null);
check('backoff: first penalty is 2 minutes', Usage.backoff.remainingMs(T0), 2 * MIN);
check('backoff: active during the wait', Usage.backoff.active(T0 + MIN), true);
check('backoff: clears once elapsed', Usage.backoff.active(T0 + 3 * MIN), false);
check('backoff: remaining never goes negative',
    Usage.backoff.remainingMs(T0 + 10 * MIN), 0);

/* Consecutive rejections double, then hold at the 30 minute cap. */
Usage.backoff.reset();
const doubling = [];
for (let i = 0; i < 6; i++) {
    Usage.backoff.penalise(T0, null);
    doubling.push(Usage.backoff.remainingMs(T0) / MIN);
}
check('backoff: doubles then caps at 30m', doubling, [2, 4, 8, 16, 30, 30]);

/* A success clears the penalty, so one bad minute does not cost the next hour. */
Usage.backoff.reset();
check('backoff: reset returns to idle', Usage.backoff.active(T0), false);

/* The API sends "retry-after: 0" when it has no opinion. That must not
 * shorten the wait we would otherwise have taken. */
Usage.backoff.reset();
Usage.backoff.penalise(T0, 0);
check('backoff: retry-after 0 does not shorten',
    Usage.backoff.remainingMs(T0), 2 * MIN);

Usage.backoff.reset();
Usage.backoff.penalise(T0, 600);
check('backoff: a longer retry-after wins',
    Usage.backoff.remainingMs(T0), 10 * MIN);

Usage.backoff.reset();
Usage.backoff.penalise(T0, 30);
check('backoff: a shorter retry-after is ignored',
    Usage.backoff.remainingMs(T0), 2 * MIN);

Usage.backoff.reset();
Usage.backoff.penalise(T0, 'garbage');
check('backoff: unparseable retry-after falls back to the step',
    Usage.backoff.remainingMs(T0), 2 * MIN);

/* Jitter only ever extends the wait — never shortens it below the step, which
 * would defeat the point of backing off. */
Usage.backoff.reset();
Usage.backoff.random = () => 1;
Usage.backoff.penalise(T0, null);
check('backoff: full jitter extends, capped at +20%',
    Usage.backoff.remainingMs(T0), 2 * MIN * 1.2);

Usage.backoff.reset();
Usage.backoff.random = () => 0.5;
Usage.backoff.penalise(T0, null);
const jittered = Usage.backoff.remainingMs(T0);
check('backoff: jitter stays within [step, step*1.2]',
    jittered >= 2 * MIN && jittered <= 2 * MIN * 1.2, true);

/* Two clients hitting the same limit must not resynchronise. */
Usage.backoff.reset();
Usage.backoff.random = () => 0;
Usage.backoff.penalise(T0, null);
const clientA = Usage.backoff.remainingMs(T0);
Usage.backoff.reset();
Usage.backoff.random = () => 1;
Usage.backoff.penalise(T0, null);
check('backoff: different jitter draws diverge',
    Usage.backoff.remainingMs(T0) !== clientA, true);

Usage.backoff.random = () => 0;
Usage.backoff.reset();

/* --- login: terminal table ------------------------------------------ */

const Login = imports.login;

check('login: command invokes the auth subcommand',
    Login.LOGIN_COMMAND.indexOf('claude auth login') === 0, true);
check('login: command pauses so the result stays readable',
    Login.LOGIN_COMMAND.includes('read -n1'), true);
check('login: at least one terminal is known',
    Login.TERMINALS.length > 0, true);

/* A typo in this table only surfaces the day someone clicks Switch Account. */
for (const terminal of Login.TERMINALS) {
    const argv = terminal.argv(Login.LOGIN_COMMAND);

    check(`login[${terminal.bin}]: argv is an array`, Array.isArray(argv), true);
    check(`login[${terminal.bin}]: argv[0] matches bin`, argv[0], terminal.bin);
    check(`login[${terminal.bin}]: every arg is a non-empty string`,
        argv.every(a => typeof a === 'string' && a.length > 0), true);
    check(`login[${terminal.bin}]: the command survives into argv`,
        argv.some(a => a.includes('claude auth login')), true);
    /* Without a login shell, ~/.local/bin is missing from gnome-shell's PATH. */
    check(`login[${terminal.bin}]: uses a login shell`,
        argv.some(a => a.includes('-lc')), true);
}

/* --- panel icon ------------------------------------------------------ */

/* A malformed icon fails silently: the extension loads, the panel just has a
 * gap where the icon should be. Load it through the same loader GNOME uses.
 *
 * This caught a real regression: gdk-pixbuf sniffs the format from a 256 byte
 * window at the head of the file, and an attribution comment ahead of the
 * <svg> root pushed it to byte 262 — six bytes too far. */

imports.gi.versions.GdkPixbuf = '2.0';
const GdkPixbuf = imports.gi.GdkPixbuf;

const ICON_PATH = 'icons/claude-monitor-symbolic.svg';

let iconPixbuf = null;
try {
    iconPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(ICON_PATH, 16, 16);
} catch (e) {
    failures.push(`icon: gdk-pixbuf refused ${ICON_PATH}\n      ${e}`);
}

if (iconPixbuf) {
    check('icon: renders at panel size', iconPixbuf.get_width(), 16);
    check('icon: has an alpha channel', iconPixbuf.get_has_alpha(), true);

    /* An SVG that parses but draws nothing would still load cleanly. */
    const pixels = iconPixbuf.get_pixels();
    const channels = iconPixbuf.get_n_channels();
    let inked = 0;
    for (let i = 3; i < pixels.length; i += channels) {
        if (pixels[i] > 20)
            inked++;
    }
    check('icon: actually draws something', inked > 40, true);
}

/* --- fetchUsage's return shapes (async) ------------------------------- */

/* Everything above is synchronous. fetchUsage is not — and the invariant this
 * whole branch rests on, that the account identity travels out on *every*
 * return path including the `skip` shape a fresh login arrives in, was until
 * now verified only by a reader having read the code.
 *
 * usage.js declares everything with top-level `var`/`function`, and GJS's
 * legacy imports make those properties of the module object, so fetchUsage's
 * internal calls to readAccount/readToken/fetchLive resolve through it and
 * assigning to `Usage.readAccount` really does replace what fetchUsage calls.
 * Verified on this checkout, not assumed.
 *
 * These run after the synchronous checks and report into the same tally. */

const REAL = {
    accountPath: Usage.accountPath,
    readAccount: Usage.readAccount,
    readToken: Usage.readToken,
    fetchLive: Usage.fetchLive,
};

/* Each step installs only the stubs it needs; this puts the rest back, so a
 * step that wants the real readAccount (reading a real file through a stubbed
 * accountPath) gets it regardless of what ran before. */
function resetStubs() {
    Usage.accountPath = REAL.accountPath;
    Usage.readAccount = REAL.readAccount;
    Usage.readToken = REAL.readToken;
    Usage.fetchLive = REAL.fetchLive;
    Usage.backoff.reset();
}

const TMP_DIR = GLib.dir_make_tmp('claude-monitor-tests-XXXXXX');
const tmpPaths = [];

function writeTemp(name, text) {
    const path = GLib.build_filenamev([TMP_DIR, name]);
    GLib.file_set_contents(path, text);
    tmpPaths.push(path);
    return path;
}

function cleanupTemp() {
    for (const path of tmpPaths) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (e) {
            /* Best effort — a leftover file in /tmp is not a test failure. */
        }
    }
    try {
        Gio.File.new_for_path(TMP_DIR).delete(null);
    } catch (e) {
        /* As above. */
    }
}

/* Sequential rather than Promise.all: the steps stub module-level functions,
 * and overlapping stubs would make a failure depend on scheduling. */
function sequence(steps) {
    return steps.reduce((chain, step) => chain.then(() => step()), Promise.resolve());
}

const A_CACHE_AGE_MS = 10 * 60 * 1000;

function newAccount(overrides) {
    const account = {
        email: 'new@example.com',
        identity: 'a2:o2',
        cached: null,
        cachedAtMs: 0,
    };
    for (const key in overrides)
        account[key] = overrides[key];
    return account;
}

/* A fresh login arrives as exactly this shape: a new identity, and the previous
 * account's cache either gone or disowned. A caller that only read identity off
 * the rendering shape would never see the switch at all. */
function skipShapeCarriesIdentity() {
    resetStubs();
    Usage.readAccount = () => Promise.resolve(newAccount({}));

    return Usage.fetchUsage({ cacheOnly: true }).then(result => {
        check('async: a cache-only read with nothing to render skips',
            result.skip, true);
        check('async: identity travels on the skip shape', result.identity, 'a2:o2');
        check('async: email travels on the skip shape', result.email, 'new@example.com');
    });
}

function liveShapeCarriesIdentity() {
    resetStubs();
    Usage.readAccount = () => Promise.resolve(newAccount({}));
    Usage.readToken = () => Promise.resolve('token');
    Usage.fetchLive = () => Promise.resolve({
        usage: Usage.parseUtilization(Fixtures.LIVE_RESPONSE),
    });

    return Usage.fetchUsage().then(result => {
        check('async: identity travels on the live shape', result.identity, 'a2:o2');
        check('async: a live result says so', result.source, 'live');
        check('async: a live result carries the fetched numbers',
            result.usage.session.percent, 49);
    });
}

function fallbackShapesCarryIdentity() {
    resetStubs();
    Usage.readToken = () => Promise.resolve(null);
    Usage.readAccount = () => Promise.resolve(newAccount({
        cached: Fixtures.CACHED_UTILIZATION,
        cachedAtMs: Date.now() - A_CACHE_AGE_MS,
    }));

    return Usage.fetchUsage().then(result => {
        check('async: identity travels on the cache fallback shape',
            result.identity, 'a2:o2');
        check('async: the cache fallback says where the numbers came from',
            result.source, 'cache');
        check('async: the cache fallback still reports why it fell back',
            result.error, Usage.Err.NO_AUTH);

        /* The no-cache fallback is the shape a login with no token yet takes,
         * and it is what the post-switch retry ladder reads its identity off. */
        Usage.readAccount = () => Promise.resolve(newAccount({}));
        return Usage.fetchUsage();
    }).then(result => {
        check('async: identity travels on the no-cache fallback shape',
            result.identity, 'a2:o2');
        check('async: the no-cache fallback has nothing to render',
            result.usage, null);
        check('async: the no-cache fallback reports no-auth',
            result.error, Usage.Err.NO_AUTH);
    });
}

/* cacheBelongsTo is covered as a predicate above. This covers readAccount
 * actually applying it to a real file: between an account switch and Claude
 * Code's next read, ~/.claude.json holds the new account's identity beside the
 * old account's usage. */
function readAccountDisownsForeignCache() {
    resetStubs();

    const claudeJson = stamp => JSON.stringify({
        oauthAccount: {
            accountUuid: 'a2',
            organizationUuid: 'o2',
            emailAddress: 'new@example.com',
        },
        cachedUsageUtilization: {
            accountUuid: stamp,
            fetchedAtMs: 1700000000000,
            utilization: Fixtures.CACHED_UTILIZATION,
        },
    });

    const foreignPath = writeTemp('foreign-cache.json', claudeJson('a1'));
    const ownPath = writeTemp('own-cache.json', claudeJson('a2'));

    Usage.accountPath = () => foreignPath;

    return Usage.readAccount().then(account => {
        check('async: a foreign-stamped cache is dropped end-to-end',
            account.cached, null);
        /* The timestamp has to go with it, or the age label would describe a
         * cache that is not being shown. */
        check('async: a dropped cache takes its timestamp with it',
            account.cachedAtMs, 0);
        check('async: the new account is still read off the same file',
            account.identity, 'a2:o2');
        check('async: and so is its email', account.email, 'new@example.com');

        Usage.accountPath = () => ownPath;
        return Usage.readAccount();
    }).then(account => {
        check('async: our own cache survives the same read',
            account.cached !== null, true);
        check('async: and keeps its timestamp',
            account.cachedAtMs, 1700000000000);
    });
}

/* An unreadable ~/.claude.json used to be indistinguishable from a signed-out
 * one, and identity now drives control flow. These read real files through the
 * real Gio path, because the three cases are told apart by the error Gio
 * raises — a stub could only assert the mapping we wrote. */
function readJsonTellsAbsentFromUnreadable() {
    resetStubs();

    const validPath = writeTemp('valid.json', '{"oauthAccount":{"accountUuid":"a2"}}');
    const tornPath = writeTemp('torn.json', '{"oauthAccount": {"accou');
    const emptyPath = writeTemp('empty.json', '');
    const missingPath = GLib.build_filenamev([TMP_DIR, 'not-there.json']);

    return Usage._readJson(validPath).then(data => {
        check('async: a readable file parses', data.oauthAccount.accountUuid, 'a2');
        return Usage._readJson(missingPath);
    }).then(data => {
        /* Genuinely absent. For ~/.claude.json that is a real signed-out
         * state, and null is what says so. */
        check('async: an absent file reads as null', data, null);
        check('async: an absent file is not "no information"',
            data === undefined, false);
        return Usage._readJson(tornPath);
    }).then(data => {
        /* Claude Code writes this file atomically but has a documented
         * non-atomic fallback path. A half-written file is no information. */
        check('async: a torn file reads as undefined', data === undefined, true);
        return Usage._readJson(emptyPath);
    }).then(data => {
        check('async: an empty file is a write in progress, not a document',
            data === undefined, true);
        /* Any load error other than NOT_FOUND. A directory is used because it
         * fails the same way a permission problem does but does not depend on
         * which user runs the suite. */
        return Usage._readJson(TMP_DIR);
    }).then(data => {
        check('async: a load failure that is not NOT_FOUND reads as undefined',
            data === undefined, true);
    });
}

function readAccountReportsUnreadableAsUnknown() {
    resetStubs();

    const tornPath = writeTemp('torn-account.json', '{"oauthAccount": {"accou');
    const missingPath = GLib.build_filenamev([TMP_DIR, 'no-account.json']);

    Usage.accountPath = () => tornPath;

    return Usage.readAccount().then(account => {
        check('async: an unreadable account file yields no identity at all',
            account.identity === undefined, true);
        /* The whole point: the same call site, told apart downstream. */
        check('async: ...which the transition reads as no information',
            Usage.identityTransition(true, 'a1:o1', account.identity), 'unknown');

        Usage.accountPath = () => missingPath;
        return Usage.readAccount();
    }).then(account => {
        check('async: an absent account file is a real signed-out state',
            account.identity, null);
        check('async: ...which the transition reads as a switch',
            Usage.identityTransition(true, 'a1:o1', account.identity), 'switch');
    });
}

/* The offline fallback is the path the floor was missing from entirely:
 * notOlderThanMs only ever gated the cacheOnly branch, so a post-switch fetch
 * that came back OFFLINE reached straight past the panel clear and served the
 * account we had just left. */
function theFallbackRefusesAPreSwitchCache() {
    resetStubs();
    Usage.readToken = () => Promise.resolve(null);

    const cachedAtMs = Date.now() - A_CACHE_AGE_MS;
    const switchedAtMs = cachedAtMs + 60 * 1000;

    Usage.readAccount = () => Promise.resolve(newAccount({
        cached: Fixtures.CACHED_UTILIZATION,
        cachedAtMs,
    }));

    return Usage.fetchUsage({ cacheFloorMs: switchedAtMs }).then(result => {
        check('async: the fallback refuses a cache from before the switch',
            result.source, null);
        check('async: ...and renders nothing rather than another account',
            result.usage, null);
        check('async: ...while still reporting the error it fell back from',
            result.error, Usage.Err.NO_AUTH);
        check('async: ...and still carrying the identity',
            result.identity, 'a2:o2');

        /* With no switch to answer to, the same cache is exactly what the
         * fallback is for — falling back to older data when the API is
         * unreachable is the normal path, not a degraded one. */
        return Usage.fetchUsage({ notOlderThanMs: Date.now() });
    }).then(result => {
        check('async: without a switch the fallback still serves the cache',
            result.source, 'cache');
    });
}

/* The same floor on the cache-only path, which the watcher uses. */
function aCacheOnlyReadRefusesAPreSwitchCache() {
    resetStubs();

    const cachedAtMs = Date.now() - A_CACHE_AGE_MS;

    Usage.readAccount = () => Promise.resolve(newAccount({
        cached: Fixtures.CACHED_UTILIZATION,
        cachedAtMs,
    }));

    return Usage.fetchUsage({ cacheOnly: true, cacheFloorMs: cachedAtMs + 1 })
        .then(result => {
            check('async: a cache-only read refuses a pre-switch cache',
                result.skip, true);
            /* Even skipping, the identity travels — this is how the watcher
             * notices the switch in the first place. */
            check('async: ...and the identity still travels',
                result.identity, 'a2:o2');

            return Usage.fetchUsage({ cacheOnly: true, cacheFloorMs: cachedAtMs - 1 });
        }).then(result => {
            check('async: a cache written after the switch is served',
                result.source, 'cache');
        });
}

const ASYNC_CHECKS = [
    readJsonTellsAbsentFromUnreadable,
    readAccountReportsUnreadableAsUnknown,
    skipShapeCarriesIdentity,
    liveShapeCarriesIdentity,
    fallbackShapesCarryIdentity,
    readAccountDisownsForeignCache,
    theFallbackRefusesAPreSwitchCache,
    aCacheOnlyReadRefusesAPreSwitchCache,
];

/* --- report --------------------------------------------------------- */

function report() {
    print('');
    if (failures.length === 0) {
        print(`  All ${passed} assertions passed.`);
        print('');
        return 0;
    }

    print(`  ${passed} passed, ${failures.length} FAILED`);
    print('');
    for (const failure of failures)
        print(`  ✗ ${failure}`);
    print('');
    return 1;
}

/* The synchronous checks are all in by now. The async ones need a main loop to
 * turn, so the tally is only final once it has stopped. */
const loop = GLib.MainLoop.new(null, false);
let exitCode = 0;

sequence(ASYNC_CHECKS).catch(error => {
    failures.push(`async section threw (it never should)\n      ${error}`);
}).then(() => {
    resetStubs();
    cleanupTemp();
    exitCode = report();
    loop.quit();
});

loop.run();

if (exitCode !== 0)
    imports.system.exit(1);
