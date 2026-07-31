/* fixtures.js — payloads captured from the real API and from ~/.claude.json. */

'use strict';

/* GET https://api.anthropic.com/api/oauth/usage — trimmed to the keys we read. */
var LIVE_RESPONSE = {
    five_hour: { utilization: 49.0, resets_at: '2026-07-31T05:29:59.333076+00:00' },
    seven_day: { utilization: 75.0, resets_at: '2026-07-31T13:59:59.333103+00:00' },
    seven_day_opus: null,
    limits: [
        {
            kind: 'session',
            group: 'session',
            percent: 49,
            severity: 'normal',
            resets_at: '2026-07-31T05:29:59.333076+00:00',
            scope: null,
            is_active: false,
        },
        {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 75,
            severity: 'warning',
            resets_at: '2026-07-31T13:59:59.333103+00:00',
            scope: null,
            is_active: true,
        },
        {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 0,
            severity: 'normal',
            resets_at: null,
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
            is_active: false,
        },
    ],
};

/* ~/.claude.json → cachedUsageUtilization.utilization */
var CACHED_UTILIZATION = {
    five_hour: { utilization: 48, resets_at: '2026-07-31T05:30:00.479416+00:00' },
    seven_day: { utilization: 75, resets_at: '2026-07-31T14:00:00.479433+00:00' },
    limits: [
        {
            kind: 'session',
            group: 'session',
            percent: 48,
            resets_at: '2026-07-31T05:30:00.479416+00:00',
            scope: null,
        },
        {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 75,
            resets_at: '2026-07-31T14:00:00.479433+00:00',
            scope: null,
        },
        {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 0,
            resets_at: null,
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        },
    ],
};

/* An older account with no `limits` array at all. */
var LEGACY_RESPONSE = {
    five_hour: { utilization: 12, resets_at: '2026-07-31T05:30:00+00:00' },
    seven_day: { utilization: 34, resets_at: '2026-07-31T14:00:00+00:00' },
};

/* A plan with no Fable allowance reported. */
var NO_FABLE_RESPONSE = {
    limits: [
        { kind: 'session', percent: 5, resets_at: null, scope: null },
        { kind: 'weekly_all', percent: 10, resets_at: null, scope: null },
    ],
};
