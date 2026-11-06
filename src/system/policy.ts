import type { BatteryInfo } from "./pmset.js";
import type { AwakeState, OnBattery } from "./state.js";

export const DEFAULT_ON_BATTERY: OnBattery = "end";
export const DEFAULT_GRACE_SECONDS = 120;
export const BATTERY_FLOOR = 15;
export const BATTERY_HARD_STOP = 5;
const HOLD_STARTUP_MS = 30_000;

export type EndingReason = "unplugged" | "battery_low" | "expiring";
export type EndReason =
  | "expired"
  | "process_exited"
  | "battery_critical"
  | "unplugged"
  | "battery_low";

export interface Snapshot {
  now: number;
  pidAlive: boolean;
  battery: BatteryInfo;
}

export type Decision =
  | { type: "none" }
  | { type: "begin_grace"; reason: EndingReason; endsAt: number }
  | { type: "cancel_grace" }
  | { type: "end"; reason: EndReason };

const NONE: Decision = { type: "none" };

function isLow(battery: BatteryInfo, limit: number): boolean {
  return (
    battery.percent !== null && battery.percent <= limit && !battery.charging
  );
}

function ended(reason: EndingReason): EndReason {
  return reason === "expiring" ? "expired" : reason;
}

// `awake on` writes the state before it disables sleep, so state with sleep
// still enabled only counts as left behind once that hold had time to start.
export function isLeftoverState(
  enabled: boolean,
  state: AwakeState | null,
  now: number,
): boolean {
  if (enabled || !state) return false;
  return now - new Date(state.enabled_at).getTime() >= HOLD_STARTUP_MS;
}

// Pure decision logic for the watcher, kept free of I/O so it can be tested
// without a real lid, battery or clock.
export function decide(state: AwakeState, snapshot: Snapshot): Decision {
  const { now, pidAlive, battery } = snapshot;
  const until = state.until ? new Date(state.until).getTime() : null;

  // Limits with no grace: the deadline was announced ahead of time, a dead
  // process has nothing to clean up, and the hard stop protects the machine.
  if (until !== null && now >= until) return { type: "end", reason: "expired" };
  if (state.while_pid && !pidAlive) {
    return { type: "end", reason: "process_exited" };
  }
  if (isLow(battery, BATTERY_HARD_STOP)) {
    return { type: "end", reason: "battery_critical" };
  }

  if (state.ending) {
    const { reason, ends_at } = state.ending;
    if (now >= new Date(ends_at).getTime()) {
      return { type: "end", reason: ended(reason) };
    }
    if (reason === "unplugged" && battery.on_ac) return { type: "cancel_grace" };
    if (reason === "battery_low" && !isLow(battery, BATTERY_FLOOR)) {
      return { type: "cancel_grace" };
    }
    return NONE;
  }

  const graceEndsAt = now + state.grace_seconds * 1000;
  if (isLow(battery, BATTERY_FLOOR)) {
    return { type: "begin_grace", reason: "battery_low", endsAt: graceEndsAt };
  }
  if (state.on_battery === "end" && !battery.on_ac) {
    return { type: "begin_grace", reason: "unplugged", endsAt: graceEndsAt };
  }
  // The warning comes early instead of extending the hold, so `awake on 2h`
  // still ends after two hours.
  if (until !== null && now >= until - state.grace_seconds * 1000) {
    return { type: "begin_grace", reason: "expiring", endsAt: until };
  }
  return NONE;
}
