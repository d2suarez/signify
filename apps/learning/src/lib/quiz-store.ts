import { getDb, type Queryable } from "./db";
import type { Assignment } from "./assignments";
import { gradesFor, setGrade } from "./grades";
import { courseGrading } from "./standards";
import { topLevel } from "./standards-math";
import { shouldSnapshot, WRITING, type WritingEvent } from "./writing";
import {
  attemptsAllowed, cleanResponses, itemAnalysis, keptAttempt, levelsFromQuiz, makeLayout, minutesFor, scoreAttempt, studentItems,
  answerText, responseText, type ItemStats, type Layout, type Quiz, type Responses, type Scores, type StudentItem,
} from "./quiz";

/**
 * Quiz attempts in the database: starting, autosaving, handing in, the time
 * limit, teacher scores, regrading and the facts shown to the teacher.
 *
 * The clock is the server's. An attempt's deadline is fixed when it starts
 * (the limit times the student's extra time); saves after it (plus a short
 * grace for the network) are refused, and an attempt still open after that
 * is handed in with what was saved, timed at its deadline.
 *
 * The grade: the attempt that counts (highest or latest) is written to the
 * gradebook through setGrade, so it has the same history, release and
 * Schoology rules as every grade, once none of its questions waits for a
 * teacher. Writes by the quiz itself are recorded as by "quiz".
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

export const QUIZ_GRACE_MS = 30_000;
export const QUIZ_EVENT_LIMITS = { perSave: 40, perAttempt: 600, pasteText: 5_000 };
/** Who writes a grade the quiz worked out by itself. */
export const QUIZ_GRADER = "quiz";

export type Attempt = {
  id: string;
  assignmentId: string;
  studentId: string;
  number: number;
  quizVersion: number;
  layout: Layout;
  responses: Responses;
  scores: Scores;
  score: number | null;
  pending: number;
  version: number;
  startedAt: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  autoSubmitted: boolean;
};

function json<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}
function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function toAttempt(r: Record<string, unknown>): Attempt {
  return {
    id: String(r.id),
    assignmentId: String(r.assignment_id),
    studentId: String(r.student_id),
    number: Number(r.number),
    quizVersion: Number(r.quiz_version),
    layout: json<Layout>(r.layout, { items: [], choices: {}, targets: {} }),
    responses: json<Responses>(r.responses, {}),
    scores: json<Scores>(r.scores, {}),
    score: r.score == null ? null : Number(r.score),
    pending: Number(r.pending ?? 0),
    version: Number(r.version),
    startedAt: iso(r.started_at) as string,
    deadlineAt: iso(r.deadline_at),
    submittedAt: iso(r.submitted_at),
    autoSubmitted: !!r.auto_submitted,
  };
}

function pastDeadline(a: Pick<Attempt, "deadlineAt">, now = Date.now()): boolean {
  return !!a.deadlineAt && now > new Date(a.deadlineAt).getTime() + QUIZ_GRACE_MS;
}

// ---------- accommodations ----------

export type Accommodation = { studentId: string; timeFactor: number; extraAttempts: number };
export const TIME_FACTORS = [1, 1.25, 1.5, 2, 3] as const;

export async function accommodationFor(ctx: Ctx, courseId: string, studentId: string, q?: Queryable): Promise<Accommodation> {
  const db = q ?? await getDb();
  const rows = await db.query(
    "SELECT * FROM quiz_accommodations WHERE tenant_id = $1 AND course_id = $2 AND student_id = $3",
    [ctx.tenantId, courseId, studentId],
  );
  return rows[0]
    ? { studentId, timeFactor: Number(rows[0].time_factor), extraAttempts: Number(rows[0].extra_attempts) }
    : { studentId, timeFactor: 1, extraAttempts: 0 };
}

export async function listAccommodations(ctx: Ctx, courseId: string): Promise<Accommodation[]> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM quiz_accommodations WHERE tenant_id = $1 AND course_id = $2", [ctx.tenantId, courseId]);
  return rows.map((r) => ({ studentId: String(r.student_id), timeFactor: Number(r.time_factor), extraAttempts: Number(r.extra_attempts) }));
}

/** Set by the course's teachers, for someone Signify ID says is a student in the class now. */
export async function setAccommodation(
  ctx: Ctx, courseId: string, studentId: string, students: Set<string>, input: { timeFactor?: unknown; extraAttempts?: unknown },
): Promise<Accommodation | null> {
  if (!students.has(studentId)) return null;
  const f = Number(input.timeFactor);
  const timeFactor = Number.isFinite(f) ? Math.min(4, Math.max(1, Math.round(f * 100) / 100)) : 1;
  const x = Math.floor(Number(input.extraAttempts));
  const extraAttempts = Number.isFinite(x) ? Math.min(10, Math.max(0, x)) : 0;
  const db = await getDb();
  if (timeFactor === 1 && extraAttempts === 0) {
    await db.query("DELETE FROM quiz_accommodations WHERE tenant_id = $1 AND course_id = $2 AND student_id = $3", [ctx.tenantId, courseId, studentId]);
  } else {
    await db.query(
      `INSERT INTO quiz_accommodations (tenant_id, course_id, student_id, time_factor, extra_attempts, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (course_id, student_id) DO UPDATE SET time_factor = EXCLUDED.time_factor,
         extra_attempts = EXCLUDED.extra_attempts, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.tenantId, courseId, studentId, timeFactor, extraAttempts, ctx.userId],
    );
  }
  return { studentId, timeFactor, extraAttempts };
}

// ---------- attempts ----------

export async function attemptsOf(ctx: Ctx, assignmentId: string, studentId?: string, q?: Queryable): Promise<Attempt[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = q ?? await getDb();
  const rows = await db.query(
    `SELECT * FROM quiz_attempts WHERE tenant_id = $1 AND assignment_id = $2 AND ($3::text IS NULL OR student_id = $3)
      ORDER BY student_id, number`,
    [ctx.tenantId, assignmentId, studentId ?? null],
  );
  return rows.map(toAttempt);
}

/** Hands in a locked, open attempt: scores it, snapshots its essays, marks the work handed in. */
async function finish(t: Queryable, ctx: Ctx, a: Assignment, cur: Attempt, auto: boolean): Promise<Attempt> {
  const quiz = a.quiz as Quiz;
  const { scores, total, pending } = scoreAttempt(quiz, cur.responses, cur.scores);
  const rows = await t.query(
    `UPDATE quiz_attempts SET submitted_at = CASE WHEN $4 AND deadline_at IS NOT NULL THEN LEAST(now(), deadline_at) ELSE now() END,
            auto_submitted = $4, scores = $5::jsonb, score = $6, pending = $7, version = version + 1
      WHERE tenant_id = $1 AND id = $2 AND student_id = $3 RETURNING *`,
    [ctx.tenantId, cur.id, cur.studentId, auto, JSON.stringify(scores), total, pending],
  );
  const done = toAttempt(rows[0]);
  for (const i of quiz.items) {
    const r = done.responses[i.identifier];
    if (i.kind === "essay" && typeof r === "string") await snapshot(t, ctx.tenantId, done.id, i.identifier, r, true);
  }
  // The assignment's own record of handing in: status, late marks, This week and the parent view read it.
  await t.query(
    `INSERT INTO submissions (tenant_id, assignment_id, student_id, body, submitted_at) VALUES ($1, $2, $3, '', $4)
     ON CONFLICT (assignment_id, student_id) DO UPDATE SET submitted_at = coalesce(submissions.submitted_at, EXCLUDED.submitted_at), updated_at = now()`,
    [ctx.tenantId, a.id, cur.studentId, done.submittedAt],
  );
  return done;
}

/**
 * Hands in every attempt left open past its deadline (one student's, or the
 * whole quiz's), with what was saved. Returns the students whose grade may
 * now change.
 */
export async function closeExpired(ctx: Ctx, a: Assignment, studentId?: string): Promise<string[]> {
  if (a.kind !== "quiz" || !a.quiz) return [];
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      `SELECT * FROM quiz_attempts WHERE tenant_id = $1 AND assignment_id = $2 AND submitted_at IS NULL
          AND deadline_at IS NOT NULL AND deadline_at < now() - make_interval(secs => $4::double precision / 1000)
          AND ($3::text IS NULL OR student_id = $3) FOR UPDATE`,
      [ctx.tenantId, a.id, studentId ?? null, QUIZ_GRACE_MS],
    );
    const out: string[] = [];
    for (const r of rows) out.push((await finish(t, ctx, a, toAttempt(r), true)).studentId);
    return out;
  });
}

export type StartResult =
  | { ok: true; attempt: Attempt }
  | { ok: false; reason: "missing" | "empty" | "no-attempts" };

/** ctx.userId is the student. Gives back the open attempt if there is one. */
export async function startAttempt(ctx: Ctx, a: Assignment, rnd: () => number = Math.random): Promise<StartResult> {
  if (a.kind !== "quiz" || !a.quiz || !a.published) return { ok: false, reason: "missing" };
  if (!a.quiz.items.length) return { ok: false, reason: "empty" };
  const quiz = a.quiz;
  const db = await getDb();
  return db.tx(async (t) => {
    const all = await attemptsOf(ctx, a.id, ctx.userId, t);
    const open = all.find((x) => !x.submittedAt);
    if (open && !pastDeadline(open)) return { ok: true, attempt: open } as const;
    if (open) {
      const locked = await t.query("SELECT * FROM quiz_attempts WHERE id = $1 FOR UPDATE", [open.id]);
      await finish(t, ctx, a, toAttempt(locked[0]), true);
    }
    const acc = await accommodationFor(ctx, a.courseId, ctx.userId, t);
    const allowed = attemptsAllowed(quiz.settings, acc.extraAttempts);
    if (allowed && all.length >= allowed) return { ok: false, reason: "no-attempts" } as const;
    const minutes = minutesFor(quiz.settings, acc.timeFactor);
    const made = await t.query(
      `INSERT INTO quiz_attempts (tenant_id, assignment_id, student_id, number, quiz_version, layout, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(mins => $7::int) END)
       ON CONFLICT DO NOTHING RETURNING *`,
      [ctx.tenantId, a.id, ctx.userId, all.length + 1, a.version, JSON.stringify(makeLayout(quiz, rnd)), minutes],
    );
    if (!made[0]) {
      // Another tab started one at the same moment: that one is the attempt.
      const again = await attemptsOf(ctx, a.id, ctx.userId, t);
      const o = again.find((x) => !x.submittedAt);
      return o ? { ok: true, attempt: o } as const : { ok: false, reason: "missing" } as const;
    }
    // "Working on it" for the course page and This week.
    await t.query(
      `INSERT INTO submissions (tenant_id, assignment_id, student_id, body) VALUES ($1, $2, $3, '')
       ON CONFLICT (assignment_id, student_id) DO NOTHING`,
      [ctx.tenantId, a.id, ctx.userId],
    );
    return { ok: true, attempt: toAttempt(made[0]) } as const;
  });
}

// ---------- what the browser sends with a save ----------

export type QuizEventIn = { kind: "left" | "back"; ago: number };
export type QuizPasteIn = { item: string; ago: number; chars: number; text: string };

export function cleanQuizEvents(input: unknown): QuizEventIn[] {
  if (!Array.isArray(input)) return [];
  const out: QuizEventIn[] = [];
  for (const raw of input.slice(0, QUIZ_EVENT_LIMITS.perSave)) {
    const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (o.kind !== "left" && o.kind !== "back") continue;
    out.push({ kind: o.kind, ago: Math.min(WRITING.maxPasteAgo, Math.max(0, Math.round(Number(o.ago)) || 0)) });
  }
  return out;
}

/** Pastes into essay answers only (the quiz's essay questions). */
export function cleanQuizPastes(q: Quiz, input: unknown): QuizPasteIn[] {
  if (!Array.isArray(input)) return [];
  const essays = new Set(q.items.filter((i) => i.kind === "essay").map((i) => i.identifier));
  const out: QuizPasteIn[] = [];
  for (const raw of input.slice(0, WRITING.maxPastesPerSave)) {
    const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof o.item !== "string" || !essays.has(o.item)) continue;
    const text = typeof o.text === "string" ? o.text.slice(0, QUIZ_EVENT_LIMITS.pasteText) : "";
    const chars = Math.max(text.length, Math.min(1_000_000, Math.round(Number(o.chars)) || 0));
    if (chars <= 0) continue;
    out.push({ item: o.item, ago: Math.min(WRITING.maxPasteAgo, Math.max(0, Math.round(Number(o.ago)) || 0)), chars, text });
  }
  return out;
}

async function eventCount(t: Queryable, tenantId: string, attemptId: string): Promise<number> {
  const [{ n }] = await t.query<{ n: number }>("SELECT count(*)::int AS n FROM quiz_events WHERE tenant_id = $1 AND attempt_id = $2", [tenantId, attemptId]);
  return n;
}

async function snapshot(t: Queryable, tenantId: string, attemptId: string, itemId: string, body: string, force = false) {
  const rows = await t.query<{ at: Date | string; body: string; n: number }>(
    `SELECT at, body, (SELECT count(*)::int FROM quiz_events WHERE tenant_id = $1 AND attempt_id = $2 AND item_id = $3 AND kind = 'snapshot') AS n
       FROM quiz_events WHERE tenant_id = $1 AND attempt_id = $2 AND item_id = $3 AND kind = 'snapshot'
      ORDER BY at DESC, id DESC LIMIT 1`,
    [tenantId, attemptId, itemId],
  );
  const last = rows[0] ? { at: new Date(rows[0].at).getTime(), body: String(rows[0].body) } : null;
  if (shouldSnapshot(last, body, Date.now(), Number(rows[0]?.n ?? 0), force)) {
    await t.query(
      "INSERT INTO quiz_events (tenant_id, attempt_id, item_id, kind, body, chars) VALUES ($1, $2, $3, 'snapshot', $4, $5)",
      [tenantId, attemptId, itemId, body, body.length],
    );
  }
}

async function recordFacts(t: Queryable, tenantId: string, at: Attempt, quiz: Quiz, events: QuizEventIn[], pastes: QuizPasteIn[], responses: Responses) {
  let room = QUIZ_EVENT_LIMITS.perAttempt - await eventCount(t, tenantId, at.id);
  for (const e of events) {
    if (room-- <= 0) break;
    await t.query(
      `INSERT INTO quiz_events (tenant_id, attempt_id, kind, at) VALUES ($1, $2, $3, now() - make_interval(secs => $4::double precision / 1000))`,
      [tenantId, at.id, e.kind, e.ago],
    );
  }
  for (const p of pastes) {
    if (room-- <= 0) break;
    await t.query(
      `INSERT INTO quiz_events (tenant_id, attempt_id, item_id, kind, at, body, chars)
       VALUES ($1, $2, $3, 'paste', now() - make_interval(secs => $4::double precision / 1000), $5, $6)`,
      [tenantId, at.id, p.item, p.ago, p.text, p.chars],
    );
  }
  for (const i of quiz.items) {
    const r = responses[i.identifier];
    if (i.kind === "essay" && typeof r === "string" && r !== at.responses[i.identifier] && room > 0) {
      await snapshot(t, tenantId, at.id, i.identifier, r);
    }
  }
}

export type SaveResult =
  | { ok: true; attempt: Attempt }
  | { ok: false; reason: "conflict"; attempt: Attempt }
  | { ok: false; reason: "time-up"; attempt: Attempt }
  | { ok: false; reason: "handed-in" | "missing" };

/**
 * Saves the student's answers (all of them, each save) and the facts since
 * the last save; with `handIn`, hands the attempt in too, in the same
 * transaction. ctx.userId is the student: nobody writes into someone else's
 * attempt. After the deadline nothing new is kept and the attempt is handed
 * in with what was saved before ("time-up").
 */
export async function saveAttempt(ctx: Ctx, a: Assignment, attemptId: string, input: {
  baseVersion: number; responses?: unknown; events?: unknown; pastes?: unknown; handIn?: boolean;
}): Promise<SaveResult> {
  if (a.kind !== "quiz" || !a.quiz || !a.published || !UUID.test(attemptId)) return { ok: false, reason: "missing" };
  const quiz = a.quiz;
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM quiz_attempts WHERE tenant_id = $1 AND id = $2 AND assignment_id = $3 AND student_id = $4 FOR UPDATE",
      [ctx.tenantId, attemptId, a.id, ctx.userId],
    );
    if (!rows[0]) return { ok: false, reason: "missing" } as const;
    const cur = toAttempt(rows[0]);
    if (cur.submittedAt) return { ok: false, reason: "handed-in" } as const;
    if (pastDeadline(cur)) return { ok: false, reason: "time-up", attempt: await finish(t, ctx, a, cur, true) } as const;
    if (Number(input.baseVersion) !== cur.version) return { ok: false, reason: "conflict", attempt: cur } as const;

    const responses = input.responses === undefined ? cur.responses : cleanResponses(quiz, input.responses);
    await recordFacts(t, ctx.tenantId, cur, quiz, cleanQuizEvents(input.events), cleanQuizPastes(quiz, input.pastes), responses);
    const saved = await t.query(
      "UPDATE quiz_attempts SET responses = $3::jsonb, version = version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING *",
      [ctx.tenantId, cur.id, JSON.stringify(responses)],
    );
    const next = toAttempt(saved[0]);
    if (!input.handIn) return { ok: true, attempt: next } as const;
    return { ok: true, attempt: await finish(t, ctx, a, next, false) } as const;
  });
}

// ---------- grades ----------

/**
 * Writes the counting attempt's score to the gradebook (and its levels, in a
 * standards course), keeping the grade's flag and comment. Nothing is written
 * while that attempt has questions waiting for a teacher. `students` is the
 * class as Signify ID says now (for a student's own hand-in: just them).
 */
export async function syncGrade(ctx: Ctx, a: Assignment, studentId: string, students: Set<string>): Promise<boolean> {
  if (a.kind !== "quiz" || !a.quiz || !students.has(studentId)) return false;
  const attempts = await attemptsOf(ctx, a.id, studentId);
  const kept = keptAttempt(attempts, a.quiz.settings.keep);
  if (!kept || kept.pending > 0) return false;
  const cur = (await gradesFor(ctx, a.id)).find((g) => g.studentId === studentId) ?? null;
  const grading = await courseGrading(ctx, a.courseId);
  const levels = grading.mode === "standards" ? levelsFromQuiz(a.quiz, a.standards, kept.scores, topLevel(grading.settings)) : undefined;
  const r = await setGrade(ctx, a, studentId, students, {
    score: kept.score ?? 0, flag: cur?.flag === "missing" ? null : cur?.flag ?? null, comment: cur?.comment ?? "", levels,
  });
  return r.ok && r.changed;
}

/** A teacher's score for one question of a handed-in attempt; null gives it back to the automatic score. */
export async function scoreQuestion(ctx: Ctx, a: Assignment, attemptId: string, itemId: string, value: unknown): Promise<Attempt | null> {
  if (a.kind !== "quiz" || !a.quiz || !UUID.test(attemptId)) return null;
  const item = a.quiz.items.find((i) => i.identifier === itemId);
  if (!item) return null;
  let score: number | null = null;
  if (value !== null && value !== undefined && value !== "") {
    const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > item.points) return null;
    score = Math.round(n * 100) / 100;
  }
  const quiz = a.quiz;
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM quiz_attempts WHERE tenant_id = $1 AND id = $2 AND assignment_id = $3 AND submitted_at IS NOT NULL FOR UPDATE",
      [ctx.tenantId, attemptId, a.id],
    );
    if (!rows[0]) return null;
    const cur = toAttempt(rows[0]);
    const prior = { ...cur.scores };
    if (score === null) delete prior[itemId]; else prior[itemId] = { score, by: ctx.userId };
    const { scores, total, pending } = scoreAttempt(quiz, cur.responses, prior);
    const saved = await t.query(
      "UPDATE quiz_attempts SET scores = $3::jsonb, score = $4, pending = $5 WHERE tenant_id = $1 AND id = $2 RETURNING *",
      [ctx.tenantId, cur.id, JSON.stringify(scores), total, pending],
    );
    return toAttempt(saved[0]);
  });
}

/**
 * After the answer key changed: every handed-in attempt scored again from
 * the current key (teachers' own scores stay), then each student's grade
 * rewritten. Grade history keeps what it was before. Students no longer in
 * the class keep their attempts' new scores but no grade is written for them.
 */
export async function regradeQuiz(ctx: Ctx, a: Assignment, students: Set<string>): Promise<{ attempts: number; grades: number }> {
  if (a.kind !== "quiz" || !a.quiz) return { attempts: 0, grades: 0 };
  const quiz = a.quiz;
  const db = await getDb();
  const changed = await db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM quiz_attempts WHERE tenant_id = $1 AND assignment_id = $2 AND submitted_at IS NOT NULL FOR UPDATE",
      [ctx.tenantId, a.id],
    );
    let n = 0;
    for (const r of rows) {
      const cur = toAttempt(r);
      const { scores, total, pending } = scoreAttempt(quiz, cur.responses, cur.scores);
      if (total === cur.score && pending === cur.pending && JSON.stringify(scores) === JSON.stringify(cur.scores)) continue;
      await t.query(
        "UPDATE quiz_attempts SET scores = $3::jsonb, score = $4, pending = $5 WHERE tenant_id = $1 AND id = $2",
        [ctx.tenantId, cur.id, JSON.stringify(scores), total, pending],
      );
      n++;
    }
    return n;
  });
  let grades = 0;
  const who = new Set((await attemptsOf(ctx, a.id)).filter((x) => x.submittedAt).map((x) => x.studentId));
  for (const s of who) if (await syncGrade(ctx, a, s, students)) grades++;
  return { attempts: changed, grades };
}

// ---------- what the student sees ----------

export type StudentQuizView = {
  allowed: number;
  used: number;
  minutes: number | null;
  open: { id: string; version: number; number: number; responses: Responses; startedAt: string; deadlineAt: string | null; items: StudentItem[] } | null;
  attempts: {
    number: number; score: number | null; pending: number; submittedAt: string | null; autoSubmitted: boolean; counts: boolean;
    /** Only when results are shown: per question, the score and (if the teacher allows) the right answer. */
    results: { identifier: string; prompt: string; points: number; yours: string; score: number | null; answer: string | null }[] | null;
  }[];
  resultsShown: boolean;
  /** The server's clock, so the countdown in the browser follows it. */
  now: string;
};

export async function studentQuiz(ctx: Ctx, a: Assignment): Promise<StudentQuizView | null> {
  if (a.kind !== "quiz" || !a.quiz) return null;
  const quiz = a.quiz;
  const [acc, list] = await Promise.all([accommodationFor(ctx, a.courseId, ctx.userId), attemptsOf(ctx, a.id, ctx.userId)]);
  const open = list.find((x) => !x.submittedAt) ?? null;
  const resultsShown = quiz.settings.results === "on-hand-in" || a.gradesReleased;
  const kept = keptAttempt(list, quiz.settings.keep);
  return {
    allowed: attemptsAllowed(quiz.settings, acc.extraAttempts),
    used: list.length,
    minutes: minutesFor(quiz.settings, acc.timeFactor),
    open: open ? {
      id: open.id, version: open.version, number: open.number, responses: open.responses,
      startedAt: open.startedAt, deadlineAt: open.deadlineAt, items: studentItems(quiz, open.layout),
    } : null,
    attempts: list.filter((x) => x.submittedAt).map((x) => ({
      number: x.number,
      score: resultsShown ? x.score : null,
      pending: x.pending,
      submittedAt: x.submittedAt,
      autoSubmitted: x.autoSubmitted,
      counts: kept?.id === x.id,
      results: resultsShown ? studentItems(quiz, x.layout).map((i) => {
        const full = quiz.items.find((q) => q.identifier === i.identifier)!;
        return {
          identifier: i.identifier, prompt: i.prompt, points: i.points,
          yours: responseText(full, x.responses[i.identifier]),
          score: x.scores[i.identifier]?.score ?? null,
          answer: quiz.settings.showAnswers ? answerText(full) || null : null,
        };
      }) : null,
    })),
    resultsShown,
    now: new Date().toISOString(),
  };
}

// ---------- what the teacher sees ----------

export type QuizFact = { kind: "left" | "back" | "paste"; at: string; item: string | null; chars: number; body: string };

export async function attemptFacts(ctx: Ctx, attemptId: string): Promise<QuizFact[]> {
  if (!UUID.test(attemptId)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT kind, at, item_id, chars, body FROM quiz_events WHERE tenant_id = $1 AND attempt_id = $2 AND kind <> 'snapshot' ORDER BY at, id`,
    [ctx.tenantId, attemptId],
  );
  return rows.map((r) => ({ kind: r.kind as QuizFact["kind"], at: iso(r.at) as string, item: r.item_id ? String(r.item_id) : null, chars: Number(r.chars), body: String(r.body) }));
}

/** Times away from the quiz page, from left/back pairs; an unmatched "left" runs to the hand-in. Plain facts. */
export function awayTimes(facts: Pick<QuizFact, "kind" | "at">[], endedAt: string | null): { from: string; to: string | null; seconds: number | null }[] {
  const out: { from: string; to: string | null; seconds: number | null }[] = [];
  let left: string | null = null;
  for (const f of facts) {
    if (f.kind === "left" && !left) left = f.at;
    else if (f.kind === "back" && left) {
      out.push({ from: left, to: f.at, seconds: Math.max(0, Math.round((Date.parse(f.at) - Date.parse(left)) / 1000)) });
      left = null;
    }
  }
  if (left) out.push({ from: left, to: endedAt, seconds: endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(left)) / 1000)) : null });
  return out;
}

/** One essay answer's snapshots and pastes, in the writing replay's shape. */
export async function essayWriting(ctx: Ctx, assignmentId: string, attemptId: string, itemId: string): Promise<WritingEvent[]> {
  if (!UUID.test(attemptId)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT e.kind, e.at, e.body, e.chars FROM quiz_events e JOIN quiz_attempts q ON q.id = e.attempt_id
      WHERE e.tenant_id = $1 AND q.tenant_id = $1 AND q.assignment_id = $2 AND e.attempt_id = $3 AND e.item_id = $4
        AND e.kind IN ('snapshot', 'paste')
      ORDER BY e.at, e.id`,
    [ctx.tenantId, assignmentId, attemptId, itemId],
  );
  return rows.map((r) => ({ kind: r.kind as WritingEvent["kind"], at: iso(r.at) as string, body: String(r.body), chars: Number(r.chars) }));
}

/** Per question, over each student's counting attempt. */
export async function quizAnalysis(ctx: Ctx, a: Assignment): Promise<{ stats: ItemStats[]; students: number; waiting: number }> {
  if (a.kind !== "quiz" || !a.quiz) return { stats: [], students: 0, waiting: 0 };
  const all = await attemptsOf(ctx, a.id);
  const by = new Map<string, Attempt[]>();
  for (const x of all) by.set(x.studentId, [...(by.get(x.studentId) ?? []), x]);
  const kept: Attempt[] = [];
  for (const list of by.values()) { const k = keptAttempt(list, a.quiz.settings.keep); if (k) kept.push(k); }
  return {
    stats: itemAnalysis(a.quiz, kept),
    students: kept.length,
    waiting: all.filter((x) => x.submittedAt && x.pending > 0).length,
  };
}
