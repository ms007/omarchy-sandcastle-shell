# Sandcastle shell widget

Omarchy bar widget for unattended Sandcastle (`@ai-hero/sandcastle`) spec runs. While a run is going, a plant icon sits in the bar. Click it to see the spec, every ticket with its state, and a live line for the active ticket: phase, attempt, how long the phase has run and when the agent last wrote to its log. A click on the spec or a ticket opens the GitHub issue.

The icon is hidden when no run is active. Its colour:

| Colour | Meaning |
|---|---|
| Bar foreground | Run is going, all good |
| Accent | The agent has written nothing for `stallWarnMinutes` |
| Urgent | A ticket in this run went back to you (`ready-for-human`) |

Notifications, each one sent once even with several monitors:

- a ticket went back to you (click opens the ticket)
- the run finished, with counts (click opens the spec and its summary comment)
- subscription limit reached
- the runner failed with an error
- the runner process died without finishing (crash, `kill -9`)

A Ctrl+C in the runner sends nothing.

## How it gets its data

The runner writes `.sandcastle/logs/spec-<N>-<ts>/status.json` on every state change (schema version 1). The widget never calls GitHub. Everything is event driven:

- `inotifywait` on `.sandcastle/logs` finds new runs, status updates and log writes
- `waitpid` on the runner pid detects a crash the moment it happens
- an in-process timer checks the stall threshold, plus a full re-read every 60 s while a run is active, as a safety net after suspend

`Service.qml` runs once per shell and does all of this. `BarWidget.qml` exists once per monitor and only renders. `Model.js` holds the pure logic.

A runner without `status.json` support produces no file, and the widget stays hidden.

## Install

```sh
ln -s ~/Projects/omarchy-sandcastle-shell ~/.config/omarchy/plugins/ms007.omarchy-sandcastle-shell
omarchy-shell shell rescanPlugins
omarchy plugin enable ms007.omarchy-sandcastle-shell
omarchy bar move ms007.omarchy-sandcastle-shell --section right
```

## Settings

Inline on the widget's entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "ms007.omarchy-sandcastle-shell", "projectPath": "~/Projects/skool", "stallWarnMinutes": 5 }
```

Run `omarchy-shell shell reloadConfig` after editing the file by hand.

## IPC

```sh
omarchy-shell ms007.omarchy-sandcastle-shell toggle   # also open, close
```

## Development

- `node --test tests/` runs the model tests.
- `omarchy plugin validate ~/Projects/omarchy-sandcastle-shell` checks the manifest. Point it at the repo, not the symlink.
- The shell's file watcher does not follow the symlink. Run `omarchy restart shell` after every change.
- Logs: `journalctl -t omarchy-shell -f`
- `tests/fixtures/running.json` is a valid status file. To try the widget without a real run, point `projectPath` at a scratch directory, start `sleep 600 &`, and move a copy with that pid into `<scratch>/.sandcastle/logs/spec-1-2026-01-01T00-00-00-000Z/status.json`. Use `mv`, the way the runner writes it.
