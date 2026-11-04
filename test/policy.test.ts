import assert from "node:assert/strict";
import { test } from "node:test";
import { endReason } from "../src/system/policy.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const hold = (over = {}) => ({
  enabled_at: "2026-11-04T11:00:00Z",
  until: "2026-11-04T13:00:00Z",
  ...over,
});

test("a running hold keeps going", () => {
  assert.equal(endReason(hold(), NOW, true), null);
});

test("a hold ends at its deadline", () => {
  assert.equal(endReason(hold({ until: "2026-11-04T12:00:00Z" }), NOW, true), "expired");
});

test("forever has no deadline", () => {
  assert.equal(endReason(hold({ until: null }), NOW, true), null);
});

test("a hold ends when its watched process exits", () => {
  assert.equal(endReason(hold({ while_pid: 42 }), NOW, false), "process_exited");
});

test("a dead pid is ignored without --while-pid", () => {
  assert.equal(endReason(hold(), NOW, false), null);
});
