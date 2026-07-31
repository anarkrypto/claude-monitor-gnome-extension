/* login.js — opens `claude auth login` in a terminal window.
 *
 * Signing in is an interactive browser flow, so it needs a real terminal.
 * No St/Shell imports, so the terminal table can be checked under plain gjs.
 */

'use strict';

const { GLib } = imports.gi;

/* A login shell, because gnome-shell's environment does not include
 * ~/.local/bin, where the Claude Code CLI usually lives. The pause keeps the
 * window up long enough to read the result. */
var LOGIN_COMMAND =
    'claude auth login; ' +
    'echo; read -n1 -r -p "Press any key to close this window..."';

/* First installed terminal wins. gnome-terminal leads because its `--`
 * separator takes a real argv, where `-e` variants need a quoted string. */
var TERMINALS = [
    { bin: 'gnome-terminal', argv: cmd => ['gnome-terminal', '--', 'bash', '-lc', cmd] },
    { bin: 'kgx', argv: cmd => ['kgx', '--', 'bash', '-lc', cmd] },
    { bin: 'konsole', argv: cmd => ['konsole', '-e', 'bash', '-lc', cmd] },
    { bin: 'xfce4-terminal', argv: cmd => ['xfce4-terminal', '-x', 'bash', '-lc', cmd] },
    { bin: 'alacritty', argv: cmd => ['alacritty', '-e', 'bash', '-lc', cmd] },
    { bin: 'kitty', argv: cmd => ['kitty', 'bash', '-lc', cmd] },
    { bin: 'xterm', argv: cmd => ['xterm', '-e', 'bash', '-lc', cmd] },
    {
        bin: 'x-terminal-emulator',
        argv: cmd => ['x-terminal-emulator', '-e', `bash -lc ${GLib.shell_quote(cmd)}`],
    },
];

/* Returns true if a terminal was launched. */
var openLogin = function () {
    for (const terminal of TERMINALS) {
        if (!GLib.find_program_in_path(terminal.bin))
            continue;

        try {
            const [spawned, pid] = GLib.spawn_async(
                null,
                terminal.argv(LOGIN_COMMAND),
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null);

            if (spawned) {
                GLib.spawn_close_pid(pid);
                return true;
            }
        } catch (e) {
            logError(e, `claude-monitor: could not launch ${terminal.bin}`);
        }
    }

    return false;
};
