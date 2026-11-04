import chalk from "chalk";
import { Command } from "commander";
import { startWatcher, stopWatcher } from "../system/launchd.js";
import { getBattery, isSleepDisabled, setSleepDisabled } from "../system/pmset.js";
import { clearState, writeState } from "../system/state.js";
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
usual "require password" delay. --no-lock leaves the display on instead.`,
    )
    .action(async (
      durationArg: string | undefined,
      opts: { forever?: boolean; lock: boolean; whilePid?: string },
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

        const state = {
          enabled_at: now.toISOString(),
          until: until ? until.toISOString() : null,
          no_lock: !opts.lock,
          while_pid: whilePid,
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

        const battery = await getBattery();

        if (format === "json") {
          const payload = buildStatusPayload(
            true,
            state,
            battery,
            isSudoersConfigured(),
          );
          printJson({ ...payload, duration_seconds: durationSeconds });
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
