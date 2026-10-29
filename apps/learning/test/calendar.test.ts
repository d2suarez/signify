import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { listAnnouncements, postAnnouncement, archiveAnnouncement, ANNOUNCEMENT_LIMITS } from "../src/lib/announcements";
import { monthGrid, addMonths, onSabbath, weekday } from "../src/lib/calendar";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const B = { tenantId: "school-b", userId: "teacher-9" };

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

test("announcements: posted newest first, trimmed and capped; empty ones refused; taken down by archiving", async () => {
  const [c] = await myCourses("school-a", [{ id: "a1", name: "History", role: "teacher" }]);
  assert.equal(await postAnnouncement(T, c.id, { title: "x", body: "   " }), null);
  const first = await postAnnouncement(T, c.id, { title: "  Field  trip ", body: "Bring a lunch.\r\nAnd water." });
  await new Promise((r) => setTimeout(r, 5));
  const second = await postAnnouncement(T, c.id, { body: "y".repeat(ANNOUNCEMENT_LIMITS.body + 10) });
  assert.equal(first?.title, "Field trip");
  assert.equal(first?.body, "Bring a lunch.\nAnd water.");
  assert.equal(second?.body.length, ANNOUNCEMENT_LIMITS.body);
  assert.deepEqual((await listAnnouncements(T, c.id)).map((a) => a.id), [second!.id, first!.id]);

  assert.equal(await archiveAnnouncement(B, c.id, first!.id), false, "another school can't take it down");
  assert.deepEqual(await listAnnouncements(B, c.id), [], "or read it");
  assert.equal(await archiveAnnouncement(T, c.id, "not-a-uuid"), false);
  assert.ok(await archiveAnnouncement(T, c.id, first!.id));
  assert.deepEqual((await listAnnouncements(T, c.id)).map((a) => a.id), [second!.id]);
});

test("calendar: month grids start on Sunday and cover every day once", () => {
  const nov = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(nov[0][0], "2026-11-01");
  const feb = monthGrid(2028, 1); // leap February, starts on a Tuesday
  assert.deepEqual(feb[0].slice(0, 3), [null, null, "2028-02-01"]);
  const days = feb.flat().filter(Boolean);
  assert.equal(days.length, 29);
  assert.ok(feb.every((w) => w.length === 7));
  assert.deepEqual(addMonths(2026, 11, 1), { year: 2027, month0: 0 });
  assert.deepEqual(addMonths(2027, 0, -1), { year: 2026, month0: 11 });
  assert.equal(weekday("2026-10-31"), 6);
});

test("calendar: the Sabbath is Friday from 6 pm through Saturday", () => {
  assert.equal(onSabbath("2026-10-30", "17:59"), false); // Friday afternoon
  assert.equal(onSabbath("2026-10-30", "18:00"), true);
  assert.equal(onSabbath("2026-10-30"), true, "a Friday with no time is due at the end of the day");
  assert.equal(onSabbath("2026-10-31", "08:00"), true); // Saturday
  assert.equal(onSabbath("2026-11-01", "08:00"), false); // Sunday
  assert.equal(onSabbath(null), false);
});
