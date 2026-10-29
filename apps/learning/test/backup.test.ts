import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment } from "../src/lib/assignments";
import { setGrade } from "../src/lib/grades";
import { addStandard, setGradingMode } from "../src/lib/standards";
import { toolKey } from "../src/lib/lti";

// The backup module reads its settings when loaded, so the stub bucket and
// the key are set first and the module is loaded after.
const KEY = crypto.randomBytes(32).toString("hex");
const objects = new Map<string, Buffer>();
let bucket: http.Server;
let dbbackup: typeof import("../dbbackup.js");
let source: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };

before(async () => {
  bucket = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const key = decodeURIComponent(url.pathname.replace(/^\/learning-test\/?/, ""));
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!/^AWS4-HMAC-SHA256 Credential=test-key\//.test(String(req.headers.authorization))) { res.statusCode = 403; return res.end(); }
      if (req.method === "PUT") { objects.set(key, Buffer.concat(chunks)); return res.end(); }
      if (req.method === "DELETE") { objects.delete(key); res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const p = url.searchParams.get("prefix") || "";
        return res.end(`<ListBucketResult>${[...objects.keys()].filter((k) => k.startsWith(p)).map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
      }
      res.statusCode = 404; res.end();
    });
  });
  await new Promise<void>((r) => bucket.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    R2_ENDPOINT: `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`, R2_BUCKET: "learning-test",
    R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret", BACKUP_ENCRYPTION_KEY: KEY,
  });
  dbbackup = require("../dbbackup.js");

  source = await openPglite("memory://");
  await migrate(source, path.join(__dirname, "..", "migrations"));
  useDb(source);
  const [c] = await myCourses("school-a", [{ id: "bk1", name: "Economics", role: "teacher" }]);
  await setGradingMode(T, c.id, "standards");
  const s = await addStandard(T, c.id, "MICRO.1", "Supply and demand");
  const a = await createAssignment(T, c.id, { title: "Essay" });
  const saved = await saveAssignment(T, a.id, { baseVersion: a.version, points: 12.5, standards: [s!.id], dueOn: "2026-10-20", dueAt: "2026-10-20T15:00:00.000Z" });
  assert.ok(saved.ok);
  await setGrade(T, saved.assignment, "stu-1", new Set(["stu-1"]), { score: 11.25, comment: "Good—“quotes” ✓", levels: { [s!.id]: 3 } });
  await toolKey("school-a"); // a private key: must never be in a backup
});
after(async () => { await source.close(); bucket.close(); });

test("backup: the nightly job sends one encrypted file a restore brings back exactly", async () => {
  const log = { log: () => {}, error: (...a: unknown[]) => { throw new Error(String(a)); } };
  const r = await dbbackup.maybeBackup(source, { log });
  assert.ok(r.ok && r.name);
  assert.equal((await dbbackup.maybeBackup(source, { log })).skipped, "already done today");
  const keys = [...objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^learning\/backup-\d{4}-\d{2}-\d{2}\.json\.gz\.enc$/);
  const sent = objects.get(keys[0])!;
  assert.equal(sent.subarray(0, 16).toString(), "SIGNIFY-BACKUP-1", "encrypted before it left");
  assert.ok(!sent.includes(Buffer.from("MICRO.1")), "no readable data in the bucket");

  const snapshot = dbbackup.unpack(sent);
  assert.ok(!("lti_keys" in snapshot.tables), "private keys are never backed up");
  assert.ok(!("schema_migrations" in snapshot.tables));
  assert.throws(() => dbbackup.unpack(sent, Buffer.alloc(32, 1)), /wrong key/);

  const target = await openPglite("memory://");
  try {
    const out = await dbbackup.restore(target, snapshot);
    assert.deepEqual(out.counts, dbbackup.counts(snapshot), "every table, every row");
    for (const t of ["courses", "standards", "assignments", "grades", "grade_history"]) assert.ok(out.counts[t] >= 1, t);
    // Values come back exactly: numerics, jsonb, text, timestamps.
    const [g] = await target.query("SELECT score::text, comment, levels, graded_at FROM grades");
    const [g0] = await source.query("SELECT score::text, comment, levels, graded_at FROM grades");
    assert.deepEqual(g, g0);
    const [a] = await target.query("SELECT points::text, due_on::text, due_at, standards FROM assignments");
    const [a0] = await source.query("SELECT points::text, due_on::text, due_at, standards FROM assignments");
    assert.deepEqual(a, a0);
    // The migration ledger is rebuilt, and sequences carry on past restored ids.
    assert.equal((await target.query("SELECT count(*)::int AS n FROM schema_migrations"))[0].n, snapshot.migrations.length);
    const before = Number((await target.query("SELECT max(id)::int AS id FROM grade_history"))[0].id);
    await target.query("INSERT INTO grade_history (tenant_id, assignment_id, student_id, changed_by) SELECT tenant_id, assignment_id, student_id, 'x' FROM grade_history LIMIT 1");
    const next = Number((await target.query("SELECT max(id)::int AS id FROM grade_history"))[0].id);
    assert.equal(next, before + 1);
    // Never over a database that has courses in it.
    await assert.rejects(dbbackup.restore(target, snapshot), /already holds 1 course/);
  } finally {
    await target.close();
  }
});

test("backup: a backup from newer code is refused", async () => {
  const snapshot = { format: dbbackup.FORMAT, dumpedAt: "", migrations: ["999_future.sql"], excluded: [], tables: {} };
  const target = await openPglite("memory://");
  try {
    await assert.rejects(dbbackup.restore(target, snapshot), /newer code/);
  } finally {
    await target.close();
  }
});
