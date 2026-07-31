#!/usr/bin/env gjs
/* run-tests.js — exercises the pure half of usage.js outside GNOME Shell.
 *
 *   cd claude-monitor@anarkrypto && gjs test/run-tests.js
 */

'use strict';

const { GLib } = imports.gi;

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

/* --- report --------------------------------------------------------- */

print('');
if (failures.length === 0) {
    print(`  All ${passed} assertions passed.`);
    print('');
} else {
    print(`  ${passed} passed, ${failures.length} FAILED`);
    print('');
    for (const failure of failures)
        print(`  ✗ ${failure}`);
    print('');
    imports.system.exit(1);
}
