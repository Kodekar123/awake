import chalk from "chalk";
import { Command } from "commander";
import { startWatcher, stopWatcher } from "../system/launchd.js";
import { getBattery, isSleepDisabled, setSleepDisabled } from "../system/pmset.js";
import { DEFAULT_GRACE_SECONDS, DEFAULT_ON_BATTERY } from "../system/policy.js";
import { clearState, readState, writeState } from "../system/state.js";
import { buildStatusPayload } from "../system/statusPayload.js";
import { isSudoersConfigured } from "../system/sudoers.js";
import {
  type GlobalFlags,
  resolveFormat,
} from "../output/formatter.js";
import { printJson } from "../output/json.js";
import {
  formatClock,
  formatDuration,
  parseDuration,
} from "../utils/duration.js";
import { CLIError, handleError } from "../utils/errors.js";
import { requireMacOS } from "../utils/platform.js";

const AGENT_HINT =
  "Run `awake wait --json` as a background task. It exits when the hold starts ending, so you can save your work and then run `awake done`. Run `awake off` if you finish first.";

function isWatchablePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createOnCommand(): Command {
  const cmd = new Command("on")
    .description("Keep the Mac awake with the lid closed (default: 1h)")
    .argument("[duration]", 'How long, e.g. "30m", "2h", "1h30m" (default 1h)')
    .option("--forever", "No auto-off timer (you must run `awake off`)")
    .option("--no-lock", "Leave the display on when the lid closes, so the screen won't lock")
    .option("--while-pid <pid>", "End the hold as soon as this process exits")
    .option("--grace <duration>", "Warning before the hold ends (default 2m, 0 for none)")
    .option("--allow-battery", "Keep the hold going on battery power")
    .option("--end-on-battery", "End the hold when the charger is unplugged (default)")
    .option("--on-ending <command>", "Run this shell command when the grace period starts")
    .addHelpText(
      "after",
      `
Examples:
  awake on                 # stay awake for 1 hour
  awake on 3h              # stay awake for 3 hours
  awake on 45m --json      # agent-friendly output
  awake on --forever       # stay awake until awake off
  awake on 2h --while-pid 1234  # or until process 1234 exits, if sooner

The display turns off when the lid closes and macOS locks the screen with your
usual "require password" delay. --no-lock leaves the display on instead.

Before a hold ends you get a grace period to wrap up (--grace), started by the
timer, by hitting 15% battery, or by unplugging the charger. Plugging back in
cancels it. --allow-battery keeps the hold going unplugged. At 5% it stops with
no grace, whatever the flags say. Agents: run awake wait to be told.`,
    )
    .action(async (
      durationArg: string | undefined,
      opts: {
        forever?: boolean;
        lock: boolean;
        whilePid?: string;
        grace?: string;
        allowBattery?: boolean;
        endOnBattery?: boolean;
        onEnding?: string;
      },
    ) => {
      const globals = cmd.parent?.opts() as GlobalFlags;
      const format = resolveFormat(globals);

      try {
        requireMacOS();
        if (durationArg && opts.forever) {
          throw new CLIError("Pass a duration or --forever, not both.", {
            code: "invalid_arguments",
          });
        }

        const whilePid = opts.whilePid ? Number(opts.whilePid) : undefined;
        if (whilePid !== undefined && !isWatchablePid(whilePid)) {
          throw new CLIError(`No running process with pid "${opts.whilePid}".`, {
            code: "invalid_pid",
          });
        }

        const forever = Boolean(opts.forever);
        const durationSeconds = forever
          ? null
          : parseDuration(durationArg ?? "1h");
        const now = new Date();
        const until = durationSeconds
          ? new Date(now.getTime() + durationSeconds * 1000)
          : null;

        const graceSeconds =
          opts.grace === undefined
            ? DEFAULT_GRACE_SECONDS
            : opts.grace === "0"
              ? 0
              : parseDuration(opts.grace);
        if (opts.allowBattery && opts.endOnBattery) {
          throw new CLIError("Pass --allow-battery or --end-on-battery, not both.", {
            code: "invalid_arguments",
          });
        }
        const onBattery = opts.allowBattery
          ? "continue"
          : opts.endOnBattery
            ? "end"
            : DEFAULT_ON_BATTERY;

        const currentBattery = await getBattery();
        if (readState()?.ending && !currentBattery.on_ac) {
          throw new CLIError("The hold is ending and this Mac is on battery.", {
            code: "hold_ending",
            hint: "plug in the charger, or wrap up and run awake done",
          });
        }
        if (onBattery === "end" && !currentBattery.on_ac) {
          throw new CLIError("This Mac is on battery, so the hold would end right away.", {
            code: "on_battery",
            hint: "plug in the charger, or pass --allow-battery if you mean to run on battery",
          });
        }

        const state = {
          enabled_at: now.toISOString(),
          until: until ? until.toISOString() : null,
          no_lock: !opts.lock,
          while_pid: whilePid,
          on_battery: onBattery,
          grace_seconds: graceSeconds,
          on_ending: opts.onEnding,
        };
        const wasDisabled = await isSleepDisabled();

        // Start the watcher first: a crash after this point can't leave the
        // machine sleepless without it. A watcher with sleep still enabled is
        // harmless - it reaches the deadline, finds nothing to do, and exits.
        writeState(state);
        try {
          await startWatcher();
        } catch (schedulingError) {
          // Never leave the machine sleepless without its safety net.
          clearState();
          if (wasDisabled) {
            await setSleepDisabled(false);
          }
          throw schedulingError;
        }

        try {
          await setSleepDisabled(true);
        } catch (toggleError) {
          // Keep the watcher if an earlier session is still holding sleep off.
          if (!wasDisabled) {
            await stopWatcher();
            clearState();
          }
          throw toggleError;
        }

        // The menu bar app watches this file, and sleep has only just changed.
        writeState(state);

        const battery = await getBattery();

        if (format === "json") {
          const payload = buildStatusPayload(
            true,
            state,
            battery,
            isSudoersConfigured(),
          );
          printJson({
            ...payload,
            duration_seconds: durationSeconds,
            grace_seconds: graceSeconds,
            agent_hint: AGENT_HINT,
          });
          return;
        }

        console.log("");
        console.log(
          `  ${chalk.green("●")} awake is ${chalk.green.bold("on")} - your Mac will keep running with the lid closed`,
        );
        if (until && durationSeconds) {
          console.log(
            `    auto-off at ${chalk.bold(formatClock(until))} (in ${formatDuration(durationSeconds)})`,
          );
        } else {
          console.log(
            `    ${chalk.yellow("▲")} no auto-off timer - remember to run ${chalk.bold("awake off")}`,
          );
        }
        if (!battery.on_ac && battery.percent !== null) {
          console.log(
            `    ${chalk.yellow("▲")} on battery (${battery.percent}%) - staying awake will drain it faster`,
          );
        }
        console.log(chalk.dim("    turn off early: awake off"));
        console.log("");
      } catch (error) {
        handleError(error, format);
      }
    });

  return cmd;
}
