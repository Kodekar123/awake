import chalk from "chalk";
import { Command } from "commander";
import { type GlobalFlags, resolveFormat } from "../output/formatter.js";
import { printJson } from "../output/json.js";
import { restoreSleep, sleepIfLidClosed } from "../system/hold.js";
import { stopWatcher } from "../system/launchd.js";
import { readState } from "../system/state.js";
import { handleError } from "../utils/errors.js";
import { requireMacOS } from "../utils/platform.js";

export function createDoneCommand(): Command {
  const cmd = new Command("done")
    .description("Cleanup finished: skip the rest of the grace period")
    .addHelpText(
      "after",
      `
Does nothing unless the hold is already ending, so it is always safe to call.
Use awake off to end a hold that isn't ending.`,
    )
    .action(async () => {
      const globals = cmd.parent?.opts() as GlobalFlags;
      const format = resolveFormat(globals);

      try {
        requireMacOS();
        const ending = Boolean(readState()?.ending);

        if (ending) {
          await restoreSleep();
        }

        if (format === "json") {
          printJson({ ended: ending, reason: ending ? "done" : "not_ending" });
        } else {
          console.log(
            ending
              ? `\n  ${chalk.blue("○")} awake is ${chalk.bold("off")} - grace period skipped\n`
              : "\n  the hold isn't ending - nothing to do\n",
          );
        }

        if (ending) {
          await sleepIfLidClosed();
          await stopWatcher();
        }
      } catch (error) {
        handleError(error, format);
      }
    });

  return cmd;
}
