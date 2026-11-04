# awake - agent contract

`awake` keeps a Mac laptop running with the lid closed. Use it before long unattended tasks (builds, training runs, uploads) when the user asks for the machine to stay up, and turn it off when done.

## Commands

| Command | Purpose | Notes |
| --- | --- | --- |
| `awake on [duration] --json` | Keep the Mac awake | duration: `30m`, `2h`, `1h30m`, bare number = minutes; default `1h`; re-running reschedules the timer |
| `awake on --forever --json` | No auto-off | avoid unless the user explicitly wants it |
| `awake on 2h --while-pid <pid> --json` | Tie the hold to a process | ends when that process exits, or at the timer if sooner |
| `awake on 2h --no-lock --json` | Keep the display on with the lid closed | also stops the screen locking; only if the user asks |
| `awake off --json` | Restore normal sleep | idempotent (`reason: "already_off"`) |
| `awake status --json` | Current state | never requires sudo |
| `awake wait --json` | Block until the hold starts ending | run as a background task; exit `0` ending, `4` no hold |
| `awake done --json` | Cleanup finished, skip the rest of grace | does nothing unless the hold is ending |
| `awake setup --check` | Is passwordless setup done? | exit 0 yes, exit 3 no |

## Output contract

Success (stdout): `{"data": { ... }}`. Error (stderr): `{"error": {"code", "message", "hint"}, "data": null}`.

`awake status --json` data fields: `enabled`, `managed` (enabled by awake vs externally), `forever`, `since`, `until` (ISO 8601 or null), `remaining_seconds`, `ending_at`, `ending_reason`, `battery` (`percent`, `on_ac`, `charging`), `sudoers_configured`.

Exit codes: `0` success, `1` error, `2` usage error, `3` setup required, `4` no active hold (`awake wait`).

## Rules for agents

1. Output is already JSON when piped; passing `--json` anyway is harmless and explicit.
2. Never run `awake setup` yourself - it needs an interactive password prompt. On exit code 3, tell the user to run `awake setup` once in their terminal.
3. Prefer timed sessions sized to the task (for example `awake on 2h` for a long build). The timer restores normal sleep even if you crash before `awake off`.
4. Turn it off (`awake off`) when the task finishes early.
5. Check `battery.on_ac` in status output; warn the user before long awake sessions on battery power.
6. Start `awake wait --json` as a background task right after `awake on`. If it exits `0`, the hold is ending. Stop starting work that can't be interrupted, like pushes or deploys, save your progress, and run `awake done`. Sleep freezes local processes rather than killing them, so network work is what's at risk.
7. If the hold keeps going after a warning, because the charger came back, `ending_at` in `awake status` is null again. Restart `awake wait`.
8. Size `--grace` to your longest step. You only hear about a warning between steps, so a 10-minute test run needs more than the default 2 minutes.
9. Never pass `--allow-battery` unless the user asked. On battery, `awake on` fails with `on_battery`, or `hold_ending` during grace: tell the user instead of working around it.
