import { test } from "node:test";
import assert from "node:assert/strict";
import { addSchoolDays, nextSchoolDay, schoolWeek, spreadLessons, pushBack } from "../src/lib/planner";

test("planner: school days skip the weekend, never Saturday", () => {
  assert.equal(nextSchoolDay("2026-10-31"), "2026-11-02"); // Saturday → Monday
  assert.equal(addSchoolDays("2026-10-30", 1), "2026-11-02"); // Friday + 1
  assert.equal(addSchoolDays("2026-11-02", -1), "2026-10-30");
  assert.deepEqual(schoolWeek("2026-10-28"), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  assert.equal(schoolWeek("2026-11-01")[0], "2026-11-02", "a Sunday shows the coming week");
});

test("planner: plan the unit spreads lessons over school days", () => {
  const out = spreadLessons([{ id: "a" }, { id: "b" }, { id: "c" }], "2026-10-29");
  assert.deepEqual(out.map((o) => o.plannedFor), ["2026-10-29", "2026-10-30", "2026-11-02"]);
});

test("planner: a lost day pushes the rest back one school day", () => {
  const out = pushBack([
    { id: "x", plannedFor: "2026-10-28" }, { id: "y", plannedFor: "2026-10-30" }, { id: "z", plannedFor: null },
  ], "2026-10-29");
  assert.deepEqual(out, [{ id: "y", plannedFor: "2026-11-02" }]);
});

test("planner: today is the school's day, and ?week= must be a real date", async () => {
  const { todayIn, parseDay } = await import("../src/lib/planner");
  // 02:30 UTC on Oct 29 is still Oct 28 in New York.
  assert.equal(todayIn("America/New_York", new Date("2026-10-29T02:30:00Z")), "2026-10-28");
  assert.equal(parseDay("2026-10-29"), "2026-10-29");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("next week"), null);
  assert.equal(parseDay(undefined), null);
});
