import { Command } from "commander";
import {
  offDisplayIfLidClosed,
  restoreSleep,
  sleepIfLidClosed,
} from "../system/hold.js";
import { stopWatcher } from "../system/launchd.js";
import { notify } from "../system/notify.js";
import { getLid } from "../system/pmset.js";
import { endReason } from "../system/policy.js";
import { readState } from "../system/state.js";

const TICK_MS = 3000;

const END_MESSAGES = {
  expired: "Auto-off: your Mac can sleep normally again.",
  process_exited: "The watched process exited: your Mac can sleep normally again.",
};

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
      const reason = endReason(state, Date.now(), pid ? isPidAlive(pid) : true);
      if (reason) {
        await restoreSleep();
        await notify("Awake", END_MESSAGES[reason]);
        await sleepIfLidClosed();
        await stopWatcher();
        return;
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
