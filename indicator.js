/* indicator.js — the top bar button and its dropdown. */

'use strict';

const { Clutter, Gio, GLib, GObject, St } = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Login = Me.imports.login;
const Usage = Me.imports.usage;

const SEVERITIES = ['ok', 'mid', 'warn', 'crit', 'none'];

/* How often the "updated N ago" label is recomputed while the menu is open.
 * Only runs while it is actually visible. */
const AGE_TICK_SECONDS = 15;

/* Shown between noticing a switch and having the new account's numbers. Not an
 * entry in ERROR_TEXT: it is a transient state, not a fault. */
const SWITCH_STATUS = 'Loading usage for the new account…';

const ERROR_TEXT = {
    'no-auth': 'Not signed in — use Switch Account to sign in',
    'expired': 'Token expired — sign in again to refresh it',
    'offline': 'Usage API unreachable',
    'rate-limited': 'Rate limited by the usage API',
};

function _row(labelText) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
    });

    const name = new St.Label({
        text: labelText,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const detail = new St.Label({
        style_class: 'claude-monitor-dim',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const value = new St.Label({
        style_class: 'claude-monitor-menu-value',
        y_align: Clutter.ActorAlign.CENTER,
    });

    item.add_child(name);
    item.add_child(detail);
    item.add_child(value);

    return { item, detail, value };
}

var ClaudeMonitorIndicator = GObject.registerClass(
class ClaudeMonitorIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'Claude Monitor');

        this._destroyed = false;
        /* Guards against a slow request landing after a newer one. */
        this._generation = 0;
        /* When the displayed numbers were obtained, absolute so the age label
         * keeps counting up between renders. */
        this._dataTimestampMs = null;
        this._ageTickId = 0;
        /* The account the numbers on screen belong to, and whether anything
         * has been adopted at all — null is a real value here, it means
         * signed out. */
        this._identity = null;
        this._identityAdopted = false;
        /* When the account last changed. No cache written before that moment
         * may be rendered: the cache carries only an accountUuid, so a move
         * between organisations leaves one on disk that cacheBelongsTo cannot
         * reject. See Usage.cacheFloor. */
        this._cacheFloorMs = 0;

        /* Separate from _generation on purpose: only a newer switch may cancel
         * a post-switch fetch. An ordinary cache-only read superseding it left
         * the panel stranded under a "Loading…" status with nothing in flight. */
        this._switchGeneration = 0;
        this._switchAttempt = 0;
        this._switchRetryId = 0;
        /* True for the ladder's whole lifetime, not just while a retry timer is
         * pending. Deriving it from `_switchRetryId` left four windows per
         * switch where the status row was unguarded — the initial fetch and
         * each in-flight attempt, since the timer is zeroed before dispatch —
         * and the first of them sits immediately after the panel clears,
         * exactly when someone is most likely to press ⟳. */
        this._switchLadderActive = false;

        this._buildPanel(extensionPath);
        this._buildMenu();

        /* Opening the menu reads the cache — free and instant. It deliberately
         * does not hit the API: the background poll already keeps the data
         * within its refresh window, and spending a request per menu-open is
         * how you get throttled. The age label says how old the data is and
         * the refresh button is right beside it. */
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this.refresh({ cacheOnly: true });
                this._updateAgeLabel();
                this._startAgeTicker();
            } else {
                this._stopAgeTicker();
            }
        });
    }

    _buildPanel(extensionPath) {
        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box claude-monitor-box',
        });

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extensionPath}/icons/claude-monitor-symbolic.svg`),
            style_class: 'system-status-icon',
        });

        this._sessionLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        const separator = new St.Label({
            text: '|',
            style_class: 'claude-monitor-sep',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._weekLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(icon);
        box.add_child(this._sessionLabel);
        box.add_child(separator);
        box.add_child(this._weekLabel);

        this.add_child(box);

        this._setValue(this._sessionLabel, null);
        this._setValue(this._weekLabel, null);
    }

    _buildHeader() {
        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._emailLabel = new St.Label({
            style_class: 'claude-monitor-email',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._ageLabel = new St.Label({
            style_class: 'claude-monitor-age',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const refreshButton = new St.Button({
            style_class: 'claude-monitor-icon-button',
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'popup-menu-icon',
            }),
            accessible_name: 'Refresh',
            can_focus: true,
        });
        refreshButton.connect('clicked', () => this.refresh({ force: true }));

        header.add_child(this._emailLabel);
        header.add_child(this._ageLabel);
        header.add_child(refreshButton);

        return header;
    }

    /* Recomputed from an absolute timestamp rather than stored as text, so it
     * stays honest while the menu sits open. */
    _updateAgeLabel() {
        if (this._dataTimestampMs === null) {
            this._ageLabel.text = '';
            return;
        }

        const age = Usage.formatAge(Math.max(0, Date.now() - this._dataTimestampMs));
        this._ageLabel.text = `updated ${age}`;
    }

    _startAgeTicker() {
        this._stopAgeTicker();
        this._ageTickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, AGE_TICK_SECONDS, () => {
                this._updateAgeLabel();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopAgeTicker() {
        if (this._ageTickId) {
            GLib.Source.remove(this._ageTickId);
            this._ageTickId = 0;
        }
    }

    _buildMenu() {
        this.menu.addMenuItem(this._buildHeader());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sessionRow = _row('Session (5h)');
        this._weekRow = _row('Week | all models');
        this._fableRow = _row('Week | Fable');

        for (const row of [this._sessionRow, this._weekRow, this._fableRow])
            this.menu.addMenuItem(row.item);

        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('claude-monitor-status');
        this._statusItem.label.clutter_text.line_wrap = true;
        this._statusItem.visible = false;
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const switchItem = new PopupMenu.PopupMenuItem('Switch Account');
        switchItem.connect('activate', () => {
            this.menu.close();
            if (!Login.openLogin()) {
                Main.notify('Claude Monitor',
                    'No terminal emulator found to run "claude auth login".');
            }
        });
        this.menu.addMenuItem(switchItem);
    }

    /* Writes "48%" (or an em dash) and swaps in the matching colour class. */
    _setValue(label, slot) {
        for (const severity of SEVERITIES)
            label.remove_style_class_name(`claude-monitor-value-${severity}`);

        const severity = slot ? Usage.severityClass(slot.percent) : 'none';
        label.add_style_class_name(`claude-monitor-value-${severity}`);
        label.text = slot ? `${slot.percent}%` : '—';
    }

    _setRow(row, slot, nowMs) {
        this._setValue(row.value, slot);

        const resets = slot ? Usage.formatResetIn(slot.resetsAt, nowMs) : null;
        row.detail.text = resets ? `resets in ${resets}` : '';
    }

    /* Errors only. The data's age is shown permanently in the header, so it no
     * longer needs to be reported here as if it were a fault — serving the
     * cache is the normal path, not a degraded one. */
    _statusText(result) {
        /* While a post-switch ladder is running, it owns this row. The error it
         * is retrying is not the truth yet, and an ordinary refresh landing
         * mid-ladder must not replace "Loading…" with a fault message the user
         * would act on right after a successful login. The guard is the ladder
         * flag rather than a pending timer, because for most of the ladder's
         * life there is no timer — only a request in flight. */
        if (this._switchLadderActive)
            return SWITCH_STATUS;

        if (!result.error || !ERROR_TEXT[result.error])
            return '';

        let text = ERROR_TEXT[result.error];

        if (result.retryInMs > 0) {
            const minutes = Math.max(1, Math.round(result.retryInMs / 60000));
            text += `, retrying in ${minutes}m`;
        }

        return text;
    }

    _render(result) {
        const nowMs = Date.now();
        const usage = result.usage;

        this._setValue(this._sessionLabel, usage ? usage.session : null);
        this._setValue(this._weekLabel, usage ? usage.weekAll : null);

        this._emailLabel.text = result.email || 'No account found';

        this._dataTimestampMs = usage ? nowMs - (result.ageMs || 0) : null;
        this._updateAgeLabel();

        this._setRow(this._sessionRow, usage ? usage.session : null, nowMs);
        this._setRow(this._weekRow, usage ? usage.weekAll : null, nowMs);
        this._setRow(this._fableRow, usage ? usage.weekFable : null, nowMs);

        const status = this._statusText(result);
        this._statusItem.label.text = status;
        this._statusItem.visible = status.length > 0;
    }

    /* The numbers on screen belong to the account we just left. Clearing beats
     * holding them until the new ones arrive: the panel is read at a glance
     * from the top of the screen, and a wrong number read at a glance is worse
     * than an em dash. Holding also has the worse failure mode — going offline
     * mid-switch would strand one account's usage under another's name with
     * nothing indicating it. */
    _onAccountSwitched(result) {
        this._adoptIdentity(result.identity);
        /* A second switch part-way through the first one's ladder. */
        this._endSwitchLadder();

        /* Before the render: from here until _fetchAfterSwitch reaches its
         * terminal path there are no fresh numbers on screen, and any refresh
         * landing in between is describing the account we just left. */
        this._switchLadderActive = true;

        this._render({
            email: result.email,
            usage: null,
            source: null,
            ageMs: 0,
            retryInMs: 0,
            error: null,
        });

        /* After _render, which clears the status row on its way past. Not shown
         * on a sign-out: there is no new account to load. */
        const status = result.identity ? SWITCH_STATUS : '';
        this._statusItem.label.text = status;
        this._statusItem.visible = status.length > 0;

        this._fetchAfterSwitch();
    }

    _adoptIdentity(identity) {
        this._identity = identity;
        this._identityAdopted = true;
    }

    /* `force` skips an active backoff, on the same grounds as the refresh
     * button: a person switching accounts is not the traffic that earned the
     * throttle. The backoff state itself is left alone — fetchLive resets it on
     * success. `notOlderThanMs: 0` because nothing is on screen to protect; the
     * switch floor is what protects this one, since an offline fetch here would
     * otherwise fall back to the cache of the account we just left. */
    _fetchAfterSwitch() {
        /* Bump both: the render generation so an older in-flight refresh cannot
         * overwrite this, and the switch token, which is what this fetch
         * actually guards on. */
        this._generation++;
        const switchGeneration = ++this._switchGeneration;

        Usage.fetchUsage({
            force: true,
            notOlderThanMs: 0,
            cacheFloorMs: this._cacheFloorMs,
        }).then(result => {
            /* Deliberately not guarded on _generation, only on the switch
             * token. This fetch is the only thing that will put numbers back on
             * a cleared panel, and an ordinary cache-only read bumping the
             * render generation used to cancel it — leaving the panel stranded
             * under "Loading…" with nothing in flight. Only a newer switch may
             * cancel this one. */
            if (this._destroyed || switchGeneration !== this._switchGeneration)
                return;

            /* Only a post-switch 401 or a momentarily-missing token earns a
             * retry, and only a bounded one. `_statusText` keeps the row on
             * "Loading…" for as long as `_switchLadderActive` is set, so
             * neither this fault nor an ordinary refresh landing mid-ladder
             * can surface it early. */
            const retryDelayMs = Usage.switchRetryDelayMs(
                result.error, this._switchAttempt, result.identity);

            if (retryDelayMs !== null) {
                this._switchAttempt++;
                this._switchRetryId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, retryDelayMs, () => {
                        this._switchRetryId = 0;
                        if (this._destroyed)
                            return GLib.SOURCE_REMOVE;
                        this._fetchAfterSwitch();
                        return GLib.SOURCE_REMOVE;
                    });
                return;
            }

            /* The ladder is over either way, and this has to happen before the
             * render: _statusText holds the row on "Loading…" for as long as
             * the ladder is running, so leaving the flag up here would hide the
             * very error the ladder just gave up on. */
            this._endSwitchLadder();

            /* Re-adopt: the account may have moved again while this was in
             * flight, and rendering under a stale adopted identity would show
             * a third account's numbers until the next read corrected it.
             * Never `undefined` though — that is the account file being
             * unreadable, and adopting it would make the next good read look
             * like yet another switch. */
            if (result.identity !== undefined)
                this._adoptIdentity(result.identity);
            this._render(result);
        }).catch(error => {
            logError(error, 'claude-monitor: post-switch refresh failed');
        });
    }

    /* Everything that ends a ladder, in one place: the pending retry if there
     * is one, the attempt counter, and the flag the status row guards on.
     * Every terminal path goes through here — the ladder giving up, a second
     * switch starting a new one, a switch that already has live data, and
     * destroy — so the flag can never outlive the thing it describes. */
    _endSwitchLadder() {
        this._cancelSwitchRetry();
        this._switchAttempt = 0;
        this._switchLadderActive = false;
    }

    _cancelSwitchRetry() {
        if (this._switchRetryId) {
            GLib.Source.remove(this._switchRetryId);
            this._switchRetryId = 0;
        }
    }

    refresh({ force = false, cacheOnly = false } = {}) {
        if (this._destroyed)
            return;

        const generation = ++this._generation;

        Usage.fetchUsage({
            force,
            cacheOnly,
            /* What's on screen, so a cache read can't overwrite fresher data. */
            notOlderThanMs: this._dataTimestampMs || 0,
            /* When the account last changed, so no read of any kind can serve
             * a cache from before it. */
            cacheFloorMs: this._cacheFloorMs,
        }).then(result => {
            /* The extension may have been disabled, or a newer refresh may
             * have overtaken this one, while the request was in flight. */
            if (this._destroyed || generation !== this._generation)
                return;

            /* Decided ahead of `skip`, because a cache-only read with nothing
             * to render is exactly how a fresh login arrives: new identity,
             * and the previous account's cache gone or disowned. */
            const transition = Usage.identityTransition(
                this._identityAdopted, this._identity, result.identity);

            if (transition === 'switch') {
                /* Set here rather than in _onAccountSwitched so it covers every
                 * way a switch is handled, including the ones that already hold
                 * the new account's numbers: the floor outlives this render and
                 * is what stops a later offline fallback reaching the previous
                 * account's cache. */
                this._cacheFloorMs = Date.now();

                this._onAccountSwitched(result);
                return;
            }

            /* 'unknown' is ~/.claude.json being unreadable — a torn write, a
             * permission problem — which says nothing about who is signed in.
             * Leave the adopted identity alone: adopting `undefined` would make
             * the next good read look like a switch and spend a forced request
             * on it. The result itself is still rendered normally; whatever
             * error it carries is the truth about the API, not about identity. */
            if (transition !== 'unknown')
                this._adoptIdentity(result.identity);

            /* A cache-only read with nothing cached — leave what's on screen. */
            if (result.skip)
                return;
            this._render(result);
        }).catch(error => {
            logError(error, 'claude-monitor: refresh failed');
        });
    }

    destroy() {
        this._destroyed = true;
        this._stopAgeTicker();
        /* A pending retry outliving the indicator would fire into a destroyed
         * actor. */
        this._endSwitchLadder();
        super.destroy();
    }
});
