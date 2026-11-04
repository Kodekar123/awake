import { spawn } from "node:child_process";
import { Command } from "commander";
import {
  offDisplayIfLidClosed,
  restoreSleep,
  sleepIfLidClosed,
} from "../system/hold.js";
import { stopWatcher } from "../system/launchd.js";
import { notify } from "../system/notify.js";
import { getBattery, getLid } from "../system/pmset.js";
import { type EndReason, type EndingReason, decide } from "../system/policy.js";
import { readState, writeState } from "../system/state.js";
import { formatDuration } from "../utils/duration.js";

const TICK_MS = 3000;

const END_MESSAGES: Record<EndReason, string> = {
  expired: "Auto-off: your Mac can sleep normally again.",
  process_exited: "The watched process exited: your Mac can sleep normally again.",
  battery_critical: "Battery critical: stopping the hold now.",
  unplugged: "Still unplugged: stopping the hold.",
  battery_low: "Battery low: stopping the hold.",
};

const ENDING_MESSAGES: Record<EndingReason, (grace: string) => string> = {
  unplugged: (grace) => `Charger unplugged: stopping in ${grace} unless you plug back in.`,
  battery_low: (grace) => `Battery low: stopping in ${grace} unless it starts charging.`,
  expiring: (grace) => `Timer ending: stopping in ${grace}.`,
};

// Detached with its own process group, so the hook survives the watcher
// being stopped by launchd.
function runOnEnding(command: string, reason: string, endsAt: string): void {
  spawn("/bin/sh", ["-c", command], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AWAKE_ENDING_REASON: reason,
      AWAKE_ENDS_AT: endsAt,
    },
  }).unref();
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Runs for as long as a hold is active, started by launchd (KeepAlive), so it
// comes back after a crash or reboot. Compares real timestamps on every tick,
// so clock changes and sleep can't make it miss the deadline.
async function watch(): Promise<void> {
  let lidWasClosed = (await getLid()).closed;

  for (;;) {
    try {
      const state = readState();
      if (!state) {
        // `awake off` got here first, or the state is gone: never stay
        // sleepless without a hold to justify it.
        await restoreSleep();
        await stopWatcher();
        return;
      }

      const pid = state.while_pid;
      const decision = decide(state, {
        now: Date.now(),
        pidAlive: pid ? isPidAlive(pid) : true,
        battery: await getBattery(),
      });

      if (decision.type === "end") {
        await restoreSleep();
        await notify("Awake", END_MESSAGES[decision.reason]);
        await sleepIfLidClosed();
        await stopWatcher();
        return;
      }

      if (decision.type === "begin_grace") {
        const { reason, endsAt } = decision;
        const ends_at = new Date(endsAt).toISOString();
        writeState({ ...state, ending: { reason, ends_at } });
        await notify(
          "Awake",
          ENDING_MESSAGES[reason](formatDuration((endsAt - Date.now()) / 1000)),
        );
        if (state.on_ending) {
          runOnEnding(state.on_ending, reason, ends_at);
        }
      }

      if (decision.type === "cancel_grace") {
        writeState({ ...state, ending: null });
        await notify("Awake", "Power is back: staying awake.");
      }

      const { closed } = await getLid();
      if (closed && !lidWasClosed && !state.no_lock) {
        await offDisplayIfLidClosed();
      }
      lidWasClosed = closed;
    } catch (error) {
      // Stay alive: this loop is the safety net, so retry on the next tick.
      console.error(`awake watch: ${(error as Error).message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

export function createWatchCommand(): Command {
  return new Command("watch")
    .description("Internal: supervises an active hold (started by launchd)")
    .action(watch);
}
