import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKstParts, loadHolidayDates, runSchedulerTick, SCHEDULES } from "../src/scheduler.js";

test("scheduler contract uses the production 11:25 and 17:25 times", () => {
  assert.deepEqual(SCHEDULES.map(({ hour, minute }) => [hour, minute]), [[11, 25], [17, 25]]);
  assert.deepEqual(getKstParts(new Date("2026-07-13T02:25:00.000Z")), {
    dateKey: "2026-07-13",
    weekday: "Mon",
    hour: 11,
    minute: 25
  });
});

test("runSchedulerTick sends once and persists the idempotency key", async () => {
  const calls = [];
  let saved;
  const result = await runSchedulerTick(async (payload) => calls.push(payload), {
    date: new Date("2026-07-13T02:25:10.000Z"),
    holidayCheck: () => false,
    getState: () => ({ version: 1, sentKeys: [] }),
    saveState: (state) => { saved = state; }
  });

  assert.equal(result.status, "sent");
  assert.equal(calls[0].mealType, "점심");
  assert.deepEqual(saved.sentKeys, ["2026-07-13:점심"]);
});

test("runSchedulerTick catches up after a short scheduler interruption", async () => {
  const calls = [];
  const result = await runSchedulerTick(async (payload) => calls.push(payload), {
    date: new Date("2026-07-13T02:55:00.000Z"),
    holidayCheck: () => false,
    getState: () => ({ version: 1, sentKeys: [] }),
    saveState: () => {}
  });
  assert.equal(result.status, "sent");
  assert.equal(calls[0].mealType, "점심");

  const stale = await runSchedulerTick(async () => { throw new Error("send reached"); }, {
    date: new Date("2026-07-13T03:11:00.000Z"),
    holidayCheck: () => false
  });
  assert.equal(stale.status, "not-due");
});

test("runSchedulerTick skips weekends, holidays, and already-sent meals", async () => {
  const forbidden = async () => { throw new Error("send reached"); };
  assert.equal((await runSchedulerTick(forbidden, {
    date: new Date("2026-07-12T02:25:00.000Z")
  })).status, "weekend");
  assert.equal((await runSchedulerTick(forbidden, {
    date: new Date("2026-07-13T02:25:00.000Z"),
    holidayCheck: () => true
  })).status, "holiday");
  assert.equal((await runSchedulerTick(forbidden, {
    date: new Date("2026-07-13T02:25:00.000Z"),
    holidayCheck: () => false,
    getState: () => ({ sentKeys: ["2026-07-13:점심"] })
  })).status, "already-sent");
});

test("holiday data validation fails closed for missing or malformed files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ojeommwo-holiday-"));
  const filePath = path.join(dir, "holidays.json");
  try {
    assert.throws(() => loadHolidayDates(filePath), /missing/u);
    fs.writeFileSync(filePath, '{"version":1,"timezone":"Asia/Seoul","dates":["bad-date"]}', "utf8");
    assert.throws(() => loadHolidayDates(filePath, { requiredYear: "2026" }), /invalid dates array/u);
    fs.writeFileSync(filePath, '{"version":1,"timezone":"Asia/Seoul","dates":["2026-07-17"]}', "utf8");
    assert.deepEqual(loadHolidayDates(filePath), ["2026-07-17"]);
    assert.throws(() => loadHolidayDates(filePath, { requiredYear: "2027" }), /does not cover 2027/u);
    for (const [store, pattern] of [
      [{ version: 2, timezone: "Asia/Seoul", dates: ["2026-07-17"] }, /schema version 1/u],
      [{ version: 1, timezone: "UTC", dates: ["2026-07-17"] }, /timezone must be Asia\/Seoul/u],
      [{ version: 1, timezone: "Asia/Seoul", dates: ["2026-02-30"] }, /invalid calendar date/u],
      [{ version: 1, timezone: "Asia/Seoul", dates: ["2026-07-17", "2026-07-17"] }, /duplicate date/u],
      [{ version: 1, timezone: "Asia/Seoul", dates: ["2026-07-18", "2026-07-17"] }, /sorted in ascending order/u]
    ]) {
      fs.writeFileSync(filePath, JSON.stringify(store), "utf8");
      assert.throws(() => loadHolidayDates(filePath, { requiredYear: "2026" }), pattern);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
