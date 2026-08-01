/* extension.js — lifecycle: build the indicator, keep it fresh, tear down. */

'use strict';

const { GLib } = imports.gi;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Indicator = Me.imports.indicator;
const Usage = Me.imports.usage;

/* This poll is what bounds staleness. The endpoint returns no rate-limit
 * headers to calibrate against, and Claude Code — which owns it — asks far
 * less often than this (measured 46 minutes stale during continuous use), so
 * 5 minutes is already generous. A 60 second poll got this extension throttled
 * for over twenty minutes. See docs/anthropic-usage-endpoint.md. */
const REFRESH_SECONDS = 300;
const REFRESH_JITTER = 0.1;

let indicator = null;
let timeoutId = 0;
let accountWatcher = null;
let tokenWatcher = null;

/* Spread the poll across a window so that many machines — or one machine
 * restarting its Shell — don't converge on the same second. */
function nextDelaySeconds() {
    const spread = REFRESH_JITTER * (Math.random() * 2 - 1);
    return Math.round(REFRESH_SECONDS * (1 + spread));
}

function scheduleRefresh() {
    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, nextDelaySeconds(), () => {
        timeoutId = 0;
        indicator.refresh();
        scheduleRefresh();
        return GLib.SOURCE_REMOVE;
    });
}

function init() {
}

function enable() {
    indicator = new Indicator.ClaudeMonitorIndicator(Me.path);
    Main.panel.addToStatusArea('claude-monitor', indicator);

    indicator.refresh();
    scheduleRefresh();

    /* Opportunistic: picks up a newer cached value for free if Claude Code
     * happens to write one. It fires on every write to the file, most of which
     * have nothing to do with usage — fetchUsage's staleness guard is what
     * stops those from overwriting fresher data. */
    accountWatcher = Usage.watchAccount(() => indicator.refresh({ cacheOnly: true }));

    /* Not opportunistic — corrective. The watcher above reads the cache and
     * nothing else, so it cannot clear an auth fault however often it fires;
     * a new token is what clears one, and this is where a new token appears.
     * The indicator decides whether the write is worth a request. */
    tokenWatcher = Usage.watchToken(() => indicator.onTokenChanged());
}

function disable() {
    if (accountWatcher) {
        accountWatcher.cancel();
        accountWatcher = null;
    }

    if (tokenWatcher) {
        tokenWatcher.cancel();
        tokenWatcher = null;
    }

    if (timeoutId) {
        GLib.Source.remove(timeoutId);
        timeoutId = 0;
    }

    if (indicator) {
        indicator.destroy();
        indicator = null;
    }

    /* Drop any in-flight request along with the connection pool. */
    Usage.closeSession();
}
