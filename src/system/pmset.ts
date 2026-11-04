import { exec } from "../utils/exec.js";
import { SetupRequiredError } from "../utils/errors.js";

const PMSET = "/usr/bin/pmset";
const SUDO = "/usr/bin/sudo";
const IOREG = "/usr/sbin/ioreg";

// `pmset -g` only prints a SleepDisabled line when the override is active
// on recent macOS, so a missing line means sleep works normally.
export async function isSleepDisabled(): Promise<boolean> {
  const { stdout } = await exec(PMSET, ["-g"]);
  return /SleepDisabled\s+1/.test(stdout);
}

export async function setSleepDisabled(disabled: boolean): Promise<void> {
  const result = await exec(
    SUDO,
    ["-n", PMSET, "-a", "disablesleep", disabled ? "1" : "0"],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    throw new SetupRequiredError();
  }
}

export async function displaySleepNow(): Promise<void> {
  await exec(PMSET, ["displaysleepnow"], { allowFailure: true });
}

export async function sleepNow(): Promise<void> {
  await exec(PMSET, ["sleepnow"], { allowFailure: true });
}

export interface LidInfo {
  closed: boolean;
  causesSleep: boolean;
}

// causesSleep is No while docked to an external display (clamshell mode).
export async function getLid(): Promise<LidInfo> {
  const { stdout } = await exec(
    IOREG,
    ["-r", "-k", "AppleClamshellState", "-d", "1"],
    { allowFailure: true },
  );
  return {
    closed: /"AppleClamshellState" = Yes/.test(stdout),
    causesSleep: /"AppleClamshellCausesSleep" = Yes/.test(stdout),
  };
}

export interface BatteryInfo {
  percent: number | null;
  on_ac: boolean;
  charging: boolean;
}

export async function getBattery(): Promise<BatteryInfo> {
  const { stdout } = await exec(PMSET, ["-g", "batt"], { allowFailure: true });
  const percentMatch = stdout.match(/(\d+)%/);
  return {
    percent: percentMatch?.[1] ? Number(percentMatch[1]) : null,
    on_ac: stdout.includes("'AC Power'"),
    // The state token follows "NN%; " - anchor to the separator so
    // "discharging" and "not charging" don't substring-match as charging.
    charging: /;\s*(charging|finishing charge|charged)\b/.test(stdout),
  };
}
