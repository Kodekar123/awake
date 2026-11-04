import type { AwakeState } from "./state.js";

export type EndReason = "expired" | "process_exited";

// Pure decision logic for the watcher, kept free of I/O so it can be tested
// without a real lid, battery or clock.
export function endReason(
  state: AwakeState,
  now: number,
  pidAlive: boolean,
): EndReason | null {
  if (state.until && now >= new Date(state.until).getTime()) return "expired";
  if (state.while_pid && !pidAlive) return "process_exited";
  return null;
}
