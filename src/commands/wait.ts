import { Command } from "commander";
import { type GlobalFlags, resolveFormat } from "../output/formatter.js";
import { printJson } from "../output/json.js";
import { readState } from "../system/state.js";
import { formatDuration } from "../utils/duration.js";
import { handleError } from "../utils/errors.js";
import { requireMacOS } from "../utils/platform.js";

const POLL_MS = 1000;
const EXIT_NO_HOLD = 4;

export function createWaitCommand(): Command {
  const cmd = new Command("wait")
    .description("Block until the hold starts ending, then exit")
    .addHelpText(
      "after",
      `
Run this as a background task. It exits when the grace period starts, so an
agent gets told instead of having to poll.

Exit codes:
  0  the hold is ending: wrap up, then run awake done
  4  there is no hold (it never started, or has already ended)`,
    )
    .action(async () => {
      const globals = cmd.parent?.opts() as GlobalFlags;
      const format = resolveFormat(globals);

      try {
        requireMacOS();

        for (;;) {
          const state = readState();

          if (!state) {
            if (format === "json") {
              printJson({ ending: false, reason: "no_hold" });
            } else {
              console.log("\n  no active hold\n");
            }
            process.exit(EXIT_NO_HOLD);
          }

          if (state.ending) {
            const { reason, ends_at } = state.ending;
            const graceSeconds = Math.max(
              0,
              Math.round((new Date(ends_at).getTime() - Date.now()) / 1000),
            );
            if (format === "json") {
              printJson({
                ending: true,
                reason,
                ending_at: ends_at,
                grace_seconds: graceSeconds,
              });
            } else {
              console.log(
                `\n  hold ending in ${formatDuration(graceSeconds)} (${reason})\n`,
              );
            }
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (error) {
        handleError(error, format);
      }
    });

  return cmd;
}
