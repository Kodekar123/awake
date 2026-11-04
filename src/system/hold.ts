import {
  displaySleepNow,
  getLid,
  isSleepDisabled,
  setSleepDisabled,
  sleepNow,
} from "./pmset.js";
import { clearState } from "./state.js";

// Restores normal sleep and forgets the hold. Does not touch the watcher:
// when the watcher itself is the caller, stopping it kills this process, so
// that always has to be the very last step.
export async function restoreSleep(): Promise<boolean> {
  const wasEnabled = await isSleepDisabled();
  if (wasEnabled) {
    await setSleepDisabled(false);
  }
  clearState();
  return wasEnabled;
}

// "Would closing the lid have slept this Mac?" - false with the lid open and
// when docked to an external display, where sleeping would be a surprise.
async function shouldActLikeLidClosed(): Promise<boolean> {
  const lid = await getLid();
  return lid.closed && lid.causesSleep;
}

// The hold overrides lid-close sleep, and with it the display turning off.
// Turning it off here hands locking back to macOS, which applies the user's
// own "require password" delay.
export async function offDisplayIfLidClosed(): Promise<void> {
  if (await shouldActLikeLidClosed()) {
    await displaySleepNow();
  }
}

export async function sleepIfLidClosed(): Promise<void> {
  if (await shouldActLikeLidClosed()) {
    await sleepNow();
  }
}
