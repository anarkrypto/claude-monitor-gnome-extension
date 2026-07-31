#!/usr/bin/env gjs
/* smoke-live.js — runs the real fetchUsage() chain (files + HTTP) outside
 * GNOME Shell and prints exactly what the indicator would render.
 *
 *   cd claude-monitor-gnome-extension && gjs test/smoke-live.js
 *
 * Touches the network and reads your real credentials. Unlike run-tests.js it
 * asserts nothing — it is here so the IO half can be checked without
 * restarting the Shell.
 */

'use strict';

const { GLib } = imports.gi;

imports.searchPath.unshift(GLib.get_current_dir());

const Usage = imports.usage;

const loop = GLib.MainLoop.new(null, false);

function describe(name, slot) {
    if (!slot) {
        print(`  ${name.padEnd(20)} —`);
        return;
    }
    const resets = Usage.formatResetIn(slot.resetsAt, Date.now());
    const suffix = resets ? `  (resets in ${resets})` : '';
    print(`  ${name.padEnd(20)} ${String(slot.percent).padStart(3)}%  [${Usage.severityClass(slot.percent)}]${suffix}`);
}

Usage.fetchUsage().then(result => {
    print('');
    print(`  email                ${result.email || '—'}`);
    print(`  source               ${result.source || 'none'}`);
    print(`  error                ${result.error || 'none'}`);
    if (result.source === 'cache')
        print(`  cache age            ${Usage.formatAge(result.ageMs)}`);
    if (result.retryInMs > 0)
        print(`  backoff              retrying in ${Math.round(result.retryInMs / 60000)}m`);
    print('');

    if (result.usage) {
        describe('session (5h)', result.usage.session);
        describe('week (all models)', result.usage.weekAll);
        describe('week (Fable)', result.usage.weekFable);
        print('');
        const s = result.usage.session;
        const w = result.usage.weekAll;
        print(`  panel                ${s ? s.percent + '%' : '—'} | ${w ? w.percent + '%' : '—'}`);
    } else {
        print('  panel                — | —');
    }
    print('');

    Usage.closeSession();
    loop.quit();
}).catch(e => {
    print(`  fetchUsage rejected (it never should): ${e}`);
    loop.quit();
});

loop.run();
