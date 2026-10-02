import test from "node:test";
import assert from "node:assert/strict";
import { assertScheduledDeliveryAuthority } from "../src/scheduled-delivery-guard.js";

const options = { mealType: "점심", now: new Date("2026-10-06T11:25:00+09:00"),
  platform: "linux", entry: "server-cron", timezone: "Asia/Seoul",
  holidayCheck: () => false, maintenanceCheck: () => ({ state: "absent" }) };

test("scheduled guard allows Linux cron and Windows emergency only within the matching meal window", () => {
  for (const [platform, entry] of [["linux", "server-cron"], ["win32", "local-emergency"]]) {
    assert.equal(assertScheduledDeliveryAuthority({ ...options, platform, entry }).delayMs, 0);
    assert.equal(assertScheduledDeliveryAuthority({ ...options, platform, entry,
      now: new Date("2026-10-06T12:10:00+09:00") }).delayMs, 45 * 60 * 1000);
    assert.equal(assertScheduledDeliveryAuthority({ ...options, platform, entry, mealType: "저녁",
      now: new Date("2026-10-06T17:25:00+09:00") }).mealType, "저녁");
  }
});

test("direct, wrong-platform and out-of-window scheduled calls fail before provider checks", () => {
  for (const entry of [undefined, "", "local-emergency", "manual-private-test"]) {
    let checked = false;
    assert.throws(() => assertScheduledDeliveryAuthority({ ...options, entry,
      holidayCheck: () => { checked = true; return false; } }), /fenced platform wrapper/);
    assert.equal(checked, false);
  }
  for (const time of ["11:24:59", "12:10:01", "17:25:00"]) {
    assert.throws(() => assertScheduledDeliveryAuthority({ ...options,
      now: new Date(`2026-10-06T${time}+09:00`) }), /protected 45-minute/);
  }
});

test("scheduled guard rejects weekend, holidays, invalid time, timezone and every maintenance state", () => {
  assert.throws(() => assertScheduledDeliveryAuthority({ ...options,
    now: new Date("2026-10-03T11:25:00+09:00") }), /non-holiday weekdays/);
  assert.throws(() => assertScheduledDeliveryAuthority({ ...options, holidayCheck: () => true }), /non-holiday weekdays/);
  assert.throws(() => assertScheduledDeliveryAuthority({ ...options, now: new Date(NaN) }), /valid current time/);
  assert.throws(() => assertScheduledDeliveryAuthority({ ...options, timezone: "UTC" }), /Asia\/Seoul/);
  for (const state of ["active", "stale", "invalid", undefined]) {
    assert.throws(() => assertScheduledDeliveryAuthority({ ...options,
      maintenanceCheck: () => ({ state }) }), /maintenance marker/);
  }
  assert.throws(() => assertScheduledDeliveryAuthority({ ...options,
    holidayCheck: () => { throw new Error("holiday coverage missing"); } }), /holiday coverage missing/);
});
