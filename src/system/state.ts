import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OnBattery = "continue" | "end";

export interface Ending {
  reason: "unplugged" | "battery_low" | "expiring";
  ends_at: string;
}

export interface AwakeState {
  enabled_at: string;
  until: string | null;
  no_lock?: boolean;
  while_pid?: number;
  on_battery: OnBattery;
  grace_seconds: number;
  on_ending?: string;
  ending?: Ending | null;
}

export function stateDir(): string {
  return join(homedir(), "Library", "Application Support", "awake");
}

export function logFile(): string {
  return join(stateDir(), "awake.log");
}

function stateFile(): string {
  return join(stateDir(), "state.json");
}

export function readState(): AwakeState | null {
  try {
    const raw = readFileSync(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as AwakeState;
    if (typeof parsed.enabled_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeState(state: AwakeState): void {
  mkdirSync(stateDir(), { recursive: true });
  // Atomic: the watcher reads this file every few seconds, and a half-written
  // file would look like "no hold".
  const tmp = `${stateFile()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, stateFile());
}

export function clearState(): void {
  rmSync(stateFile(), { force: true });
}
