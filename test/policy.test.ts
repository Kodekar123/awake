import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../src/system/policy.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const iso = (offsetSeconds) => new Date(NOW + offsetSeconds * 1000).toISOString();
const hold = (over = {}) => ({
  enabled_at: iso(-3600),
  until: iso(3600),
  on_battery: "end",
  grace_seconds: 120,
  ...over,
});
const plugged = { percent: 80, on_ac: true, charging: false };
const unplugged = { percent: 80, on_ac: false, charging: false };
const snap = (over = {}) => ({ now: NOW, pidAlive: true, battery: plugged, ...over });

test("a running hold keeps going", () => {
  assert.deepEqual(decide(hold(), snap()), { type: "none" });
});

test("a plugged-in Mac held at 80% is not treated as unplugged", () => {
  assert.deepEqual(decide(hold(), snap()), { type: "none" });
});

test("the deadline ends the hold, even during grace", () => {
  const state = hold({
    until: iso(0),
    ending: { reason: "unplugged", ends_at: iso(60) },
  });
  assert.deepEqual(decide(state, snap({ battery: unplugged })), {
    type: "end",
    reason: "expired",
  });
});

test("forever has no deadline", () => {
  assert.deepEqual(decide(hold({ until: null }), snap()), { type: "none" });
});

test("a watched process exiting skips grace", () => {
  assert.deepEqual(decide(hold({ while_pid: 42 }), snap({ pidAlive: false })), {
    type: "end",
    reason: "process_exited",
  });
});

test("unplugging starts grace", () => {
  assert.deepEqual(decide(hold(), snap({ battery: unplugged })), {
    type: "begin_grace",
    reason: "unplugged",
    endsAt: NOW + 120_000,
  });
});

test("unplugging is ignored when battery use is allowed", () => {
  const state = hold({ on_battery: "continue" });
  assert.deepEqual(decide(state, snap({ battery: unplugged })), { type: "none" });
});

test("plugging back in cancels unplugged grace", () => {
  const state = hold({ ending: { reason: "unplugged", ends_at: iso(60) } });
  assert.deepEqual(decide(state, snap()), { type: "cancel_grace" });
});

test("unplugged grace ends the hold when it runs out", () => {
  const state = hold({ ending: { reason: "unplugged", ends_at: iso(0) } });
  assert.deepEqual(decide(state, snap({ battery: unplugged })), {
    type: "end",
    reason: "unplugged",
  });
});

test("the floor applies even when battery use is allowed", () => {
  const state = hold({ on_battery: "continue" });
  const battery = { percent: 15, on_ac: false, charging: false };
  assert.equal(decide(state, snap({ battery })).reason, "battery_low");
});

test("a weak charger still hits the floor", () => {
  const battery = { percent: 15, on_ac: true, charging: false };
  assert.equal(decide(hold(), snap({ battery })).reason, "battery_low");
});

test("charging clears the floor", () => {
  const battery = { percent: 15, on_ac: true, charging: true };
  assert.deepEqual(decide(hold(), snap({ battery })), { type: "none" });
  const state = hold({ ending: { reason: "battery_low", ends_at: iso(60) } });
  assert.deepEqual(decide(state, snap({ battery })), { type: "cancel_grace" });
});

test("plugging in without charging does not cancel low battery grace", () => {
  const state = hold({ ending: { reason: "battery_low", ends_at: iso(60) } });
  const battery = { percent: 14, on_ac: true, charging: false };
  assert.deepEqual(decide(state, snap({ battery })), { type: "none" });
});

test("the hard stop skips grace and any setting", () => {
  const state = hold({ on_battery: "continue", grace_seconds: 3600 });
  const battery = { percent: 5, on_ac: false, charging: false };
  assert.deepEqual(decide(state, snap({ battery })), {
    type: "end",
    reason: "battery_critical",
  });
});

test("an unknown battery level is ignored", () => {
  const battery = { percent: null, on_ac: true, charging: false };
  assert.deepEqual(decide(hold(), snap({ battery })), { type: "none" });
});

test("the timer warning comes early and keeps the deadline", () => {
  assert.deepEqual(decide(hold({ until: iso(120) }), snap()), {
    type: "begin_grace",
    reason: "expiring",
    endsAt: NOW + 120_000,
  });
});

test("timer grace can't be cancelled", () => {
  const state = hold({
    until: iso(60),
    ending: { reason: "expiring", ends_at: iso(60) },
  });
  assert.deepEqual(decide(state, snap()), { type: "none" });
});
