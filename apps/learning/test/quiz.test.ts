import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, forStudent, getAssignment, saveAssignment, saveDraft, type Assignment } from "../src/lib/assignments";
import { gradeHistory, gradesFor, setGrade } from "../src/lib/grades";
import { addStandard, setGradingMode } from "../src/lib/standards";
import { alignedStandards } from "../src/lib/standards-math";
import {
  blankItem, cleanResponses, handGraded, itemAnalysis, keptAttempt, levelsFromQuiz, makeLayout, normalizeQuiz, parseNumber,
  quizPoints, responseDeclaration, scoreAttempt, scoreItem, scoringKey, studentItems, type QuizItem,
} from "../src/lib/quiz";
import {
  QUIZ_GRADER, attemptFacts, attemptsOf, awayTimes, closeExpired, cleanQuizEvents, essayWriting, quizAnalysis, regradeQuiz,
  saveAttempt, scoreQuestion, setAccommodation, startAttempt, studentQuiz, syncGrade,
} from "../src/lib/quiz-store";
import { dict } from "../src/lib/i18n";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const S1 = { tenantId: "school-a", userId: "stu-1" };
const S2 = { tenantId: "school-a", userId: "stu-2" };
const ROSTER = new Set(["stu-1", "stu-2"]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

const item = (o: Partial<QuizItem> & Pick<QuizItem, "kind">): QuizItem => ({ ...blankItem(o.kind), ...o } as QuizItem);

function sampleQuiz() {
  return {
    settings: { attempts: 2, keep: "highest", timeLimit: null, results: "on-hand-in", showAnswers: true },
    items: [
      { identifier: "q1", kind: "single", prompt: "2 + 2?", points: 2, choices: [{ identifier: "a", text: "3" }, { identifier: "b", text: "4" }], correct: ["b"] },
      { identifier: "q2", kind: "truefalse", prompt: "The sky is green.", points: 1, correct: ["false"] },
      { identifier: "q3", kind: "short", prompt: "Capital of France?", points: 2, correct: ["Paris"] },
      { identifier: "q4", kind: "essay", prompt: "Why?", points: 5 },
    ],
  };
}

let n = 0;
async function quizIn(quiz: unknown = sampleQuiz(), extra: Record<string, unknown> = {}): Promise<Assignment> {
  const [c] = await myCourses("school-a", [{ id: `qz${++n}`, name: `Course ${n}`, role: "teacher" }]);
  const a = await createAssignment(T, c.id, { title: "Quiz", kind: "quiz" });
  assert.equal(a.kind, "quiz");
  assert.equal(a.points, 0, "a new quiz has no questions, so no points");
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, quiz, ...extra });
  assert.ok(r.ok);
  return r.assignment;
}

// ---------- the model ----------

test("quiz model: QTI-shaped, cleaned, keys kept consistent", () => {
  const q = normalizeQuiz({
    settings: { attempts: 99, timeLimit: -5, keep: "weird", results: "nope" },
    items: [
      { kind: "single", choices: [{ identifier: "a", text: "x" }, { identifier: "a", text: "dup id" }], correct: ["a", "zzz"] },
      { kind: "multiple", choices: [{ text: "1" }, { text: "2" }], correct: [] },
      { kind: "order", choices: [{ identifier: "x", text: "1" }, { identifier: "y", text: "2" }], correct: ["y"] },
      { kind: "match", choices: [{ identifier: "s1", text: "dog" }], targets: [{ identifier: "t1", text: "perro" }], correct: ["s1 t1", "s1 t9", "bad"] },
      { kind: "truefalse", correct: ["maybe"] },
      { kind: "numeric", value: "3,5", tolerance: "-0.1" },
      { kind: "hack", prompt: "<script>" },
      null,
    ],
  });
  assert.equal(q.settings.attempts, 20);
  assert.equal(q.settings.timeLimit, null);
  assert.equal(q.settings.keep, "highest");
  assert.equal(q.settings.results, "on-release");
  assert.equal(q.items.length, 6, "unknown kinds dropped");
  const [single, , order, match, tf, numeric] = q.items;
  assert.notEqual(single.choices[0].identifier, single.choices[1].identifier, "ids made unique");
  assert.deepEqual(single.correct, ["a"]);
  assert.deepEqual(order.correct, ["x", "y"], "a partial order key falls back to the order written");
  assert.deepEqual(match.correct, ["s1 t1"]);
  assert.deepEqual(tf.correct, []);
  assert.equal(numeric.value, 3.5);
  assert.equal(numeric.tolerance, 0.1);
  assert.deepEqual(responseDeclaration(match), { interaction: "matchInteraction", cardinality: "multiple", baseType: "directedPair", correctResponse: ["s1 t1"] });
  assert.equal(responseDeclaration(order).cardinality, "ordered");
  assert.equal(responseDeclaration(numeric).baseType, "float");
  assert.equal(quizPoints(q), 6);
});

test("quiz scoring: every type, partial credit, tolerance and letter case", () => {
  const single = item({ kind: "single", points: 2, choices: [{ identifier: "a", text: "" }, { identifier: "b", text: "" }], correct: ["b"] });
  assert.equal(scoreItem(single, "b"), 2);
  assert.equal(scoreItem(single, "a"), 0);
  assert.equal(scoreItem(single, null), 0, "unanswered is zero");

  const multi = item({ kind: "multiple", points: 4, choices: ["a", "b", "c", "d"].map((identifier) => ({ identifier, text: "" })), correct: ["a", "b"] });
  assert.equal(scoreItem(multi, ["a", "b"]), 4);
  assert.equal(scoreItem(multi, ["a"]), 0, "all or nothing by default");
  assert.equal(scoreItem({ ...multi, partial: true }, ["a"]), 2);
  assert.equal(scoreItem({ ...multi, partial: true }, ["a", "c"]), 0, "a wrong pick cancels a right one");
  assert.equal(scoreItem({ ...multi, partial: true }, ["a", "b", "c", "d"]), 0);

  const short = item({ kind: "short", points: 1, correct: ["Paris", "París"] });
  assert.equal(scoreItem(short, "  paris "), 1);
  assert.equal(scoreItem(short, "París"), 1);
  assert.equal(scoreItem({ ...short, caseSensitive: true }, "paris"), 0);
  assert.equal(scoreItem(short, "Lyon"), 0);
  assert.equal(handGraded(item({ kind: "short", correct: [] })), true, "a short answer with no key is the teacher's");
  assert.equal(scoreItem(item({ kind: "short", correct: [] }), "x"), null);

  const numeric = item({ kind: "numeric", points: 3, value: 9.81, tolerance: 0.05 });
  assert.equal(scoreItem(numeric, "9.8"), 3);
  assert.equal(scoreItem(numeric, "9,8"), 3, "a decimal comma counts");
  assert.equal(scoreItem(numeric, "9.7"), 0);
  assert.equal(scoreItem(numeric, "nine"), 0);
  assert.equal(parseNumber("1,000"), 1000);

  const match = item({ kind: "match", points: 3, choices: ["s1", "s2", "s3"].map((identifier) => ({ identifier, text: "" })),
    targets: ["t1", "t2", "t3"].map((identifier) => ({ identifier, text: "" })), correct: ["s1 t1", "s2 t2", "s3 t3"] });
  assert.equal(scoreItem(match, { s1: "t1", s2: "t2", s3: "t3" }), 3);
  assert.equal(scoreItem(match, { s1: "t1", s2: "t3", s3: "t2" }), 0);
  assert.equal(scoreItem({ ...match, partial: true }, { s1: "t1", s2: "t3", s3: "t2" }), 1);

  const order = item({ kind: "order", points: 4, choices: ["a", "b", "c", "d"].map((identifier) => ({ identifier, text: "" })), correct: ["a", "b", "c", "d"] });
  assert.equal(scoreItem(order, ["a", "b", "c", "d"]), 4);
  assert.equal(scoreItem({ ...order, partial: true }, ["a", "b", "d", "c"]), 2);

  assert.equal(scoreItem(item({ kind: "essay" }), "words"), null, "essays are the teacher's");
});

test("quiz scoring: an attempt's total, waiting questions, and teachers' scores kept through a regrade", () => {
  const q = normalizeQuiz(sampleQuiz());
  const r = cleanResponses(q, { q1: "b", q2: "true", q3: "paris", q4: "Because.", extra: "ignored" });
  assert.deepEqual(Object.keys(r).sort(), ["q1", "q2", "q3", "q4"]);
  const first = scoreAttempt(q, r);
  assert.equal(first.total, 4);
  assert.equal(first.pending, 1, "the essay waits");
  const graded = scoreAttempt(q, r, { ...first.scores, q4: { score: 4, by: "teacher-1" } });
  assert.equal(graded.total, 8);
  assert.equal(graded.pending, 0);
  // The key changes: q2 was true after all. Auto scores move, the teacher's essay score stays.
  const q2 = normalizeQuiz({ ...sampleQuiz(), items: sampleQuiz().items.map((i) => (i.identifier === "q2" ? { ...i, correct: ["true"] } : i)) });
  assert.notEqual(scoringKey(q2), scoringKey(q));
  const again = scoreAttempt(q2, r, graded.scores);
  assert.equal(again.total, 9);
  assert.equal(again.scores.q4.by, "teacher-1");
  assert.equal(scoreAttempt(q, cleanResponses(q, {})).pending, 0, "an empty essay needs no teacher");
});

test("quiz layout: shuffles fixed per attempt; an ordering question never starts solved; no key reaches the student", () => {
  const q = normalizeQuiz({
    settings: { shuffleItems: true, shuffleChoices: true },
    items: [
      { identifier: "o", kind: "order", choices: [{ identifier: "a", text: "1" }, { identifier: "b", text: "2" }, { identifier: "c", text: "3" }] },
      { identifier: "s", kind: "single", choices: [{ identifier: "x", text: "X" }, { identifier: "y", text: "Y" }], correct: ["y"] },
      { identifier: "t", kind: "truefalse", correct: ["true"] },
    ],
  });
  let seed = 0;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let k = 0; k < 30; k++) {
    const layout = makeLayout(q, rnd);
    assert.notDeepEqual(layout.choices.o, ["a", "b", "c"]);
    assert.equal(layout.choices.t, undefined, "true/false never moves");
    assert.deepEqual([...layout.items].sort(), ["o", "s", "t"]);
  }
  const shown = studentItems(q, makeLayout(q, rnd));
  for (const i of shown) {
    assert.deepEqual(Object.keys(i).sort(), ["choices", "identifier", "kind", "points", "prompt", "targets"]);
  }
  assert.ok(!JSON.stringify(shown).includes("correct"));
});

test("quiz: attempts kept, standards levels in proportion, item analysis", () => {
  const list = [
    { number: 1, score: 7, pending: 0, submittedAt: "2026-10-01T10:00:00Z" },
    { number: 2, score: 5, pending: 0, submittedAt: "2026-10-02T10:00:00Z" },
    { number: 3, score: null, pending: 0, submittedAt: null },
  ];
  assert.equal(keptAttempt(list, "highest")?.number, 1);
  assert.equal(keptAttempt(list, "latest")?.number, 2);
  assert.equal(keptAttempt([], "latest"), null);

  const q = normalizeQuiz({ items: [
    { identifier: "a", kind: "truefalse", points: 2, correct: ["true"], standardId: "11111111-1111-1111-1111-111111111111" },
    { identifier: "b", kind: "truefalse", points: 2, correct: ["true"], standardId: "22222222-2222-2222-2222-222222222222" },
  ] });
  const scores = { a: { score: 2, by: "auto" }, b: { score: 0, by: "auto" } };
  assert.deepEqual(levelsFromQuiz(q, ["33333333-3333-3333-3333-333333333333"], scores, 4), {
    "33333333-3333-3333-3333-333333333333": 2,
    "11111111-1111-1111-1111-111111111111": 4,
    "22222222-2222-2222-2222-222222222222": 1,
  });

  const stats = itemAnalysis(q, [
    { responses: { a: "true", b: "false" }, scores },
    { responses: { a: "false", b: "true" }, scores: { a: { score: 0, by: "auto" }, b: { score: 2, by: "auto" } } },
  ]);
  assert.equal(stats[0].percentCorrect, 50);
  assert.deepEqual(stats[0].picks, { true: 1, false: 1 });
});

// ---------- in the database ----------

test("quiz: a quiz is an assignment; its key never goes to a student; it stays a quiz once tried", async () => {
  const a = await quizIn();
  assert.equal(a.points, 10, "points are the questions' total");
  assert.equal(a.quiz?.items.length, 4);
  assert.equal(forStudent(a).quiz, null);
  // The plain writing box refuses a quiz.
  assert.deepEqual(await saveDraft(S1, a, { baseVersion: 0, body: "x" }), { ok: false, reason: "missing" });
  const started = await startAttempt(S1, a);
  assert.ok(started.ok);
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, kind: "online" });
  assert.ok(r.ok);
  assert.equal(r.assignment.kind, "quiz");
  assert.equal(r.changed, false);
  const r2 = await saveAssignment(T, a.id, { baseVersion: a.version, title: "Quiz 1" });
  assert.ok(r2.ok && r2.changed);
  // The previous state is in the assignment's versions, quiz included.
  const [v] = await db.query("SELECT snapshot FROM assignment_versions WHERE assignment_id = $1 ORDER BY version DESC LIMIT 1", [a.id]);
  assert.equal((v.snapshot as { quiz: { items: unknown[] } }).quiz.items.length, 4);
});

test("quiz: start, autosave (version-checked), hand in, auto score, essay waits, teacher scores it, grade written", async () => {
  const a = await quizIn();
  const st = await startAttempt(S1, a);
  assert.ok(st.ok);
  const again = await startAttempt(S1, a);
  assert.ok(again.ok && again.attempt.id === st.attempt.id, "starting twice gives the open attempt");
  const s1 = await saveAttempt(S1, a, st.attempt.id, { baseVersion: st.attempt.version, responses: { q1: "b" } });
  assert.ok(s1.ok);
  const stale = await saveAttempt(S1, a, st.attempt.id, { baseVersion: st.attempt.version, responses: { q1: "a" } });
  assert.equal(stale.ok ? "" : stale.reason, "conflict");
  assert.equal((await saveAttempt(S2, a, st.attempt.id, { baseVersion: s1.attempt.version, responses: {} })).ok, false, "not someone else's");

  const done = await saveAttempt(S1, a, st.attempt.id, {
    baseVersion: s1.attempt.version, handIn: true,
    responses: { q1: "b", q2: "false", q3: "PARIS", q4: "Because it is." },
    events: [{ kind: "left", ago: 20_000 }, { kind: "back", ago: 5_000 }],
    pastes: [{ item: "q4", ago: 1000, chars: 12, text: "Because it is" }, { item: "q1", ago: 1, chars: 3, text: "nope" }],
  });
  assert.ok(done.ok);
  assert.ok(done.attempt.submittedAt);
  assert.equal(done.attempt.score, 5);
  assert.equal(done.attempt.pending, 1);
  assert.equal((await saveAttempt(S1, a, st.attempt.id, { baseVersion: done.attempt.version, responses: {} })).ok, false, "handed in is final");

  // Handing in marks the work handed in, like any assignment.
  const [sub] = await db.query("SELECT submitted_at FROM submissions WHERE assignment_id = $1 AND student_id = 'stu-1'", [a.id]);
  assert.ok(sub.submitted_at);

  // The essay waits for the teacher, so no grade yet.
  assert.equal(await syncGrade({ ...S1, userId: QUIZ_GRADER }, a, "stu-1", new Set(["stu-1"])), false);
  assert.equal((await gradesFor(T, a.id)).length, 0);

  assert.equal(await scoreQuestion(T, a, st.attempt.id, "q4", 99), null, "more than the question's points");
  const scored = await scoreQuestion(T, a, st.attempt.id, "q4", "4");
  assert.equal(scored?.score, 9);
  assert.equal(scored?.pending, 0);
  assert.equal(await syncGrade(T, a, "stu-1", ROSTER), true);
  assert.equal((await gradesFor(T, a.id))[0].score, 9);

  // The facts: left and came back, one paste into the essay (not into q1), an essay snapshot.
  const facts = await attemptFacts(T, st.attempt.id);
  assert.deepEqual(facts.map((f) => f.kind), ["left", "back", "paste"]);
  assert.equal(facts[2].item, "q4");
  const away = awayTimes(facts, done.attempt.submittedAt);
  assert.equal(away.length, 1);
  assert.ok(Math.abs((away[0].seconds ?? 0) - 15) <= 1);
  const essay = await essayWriting(T, a.id, st.attempt.id, "q4");
  assert.ok(essay.some((e) => e.kind === "snapshot" && e.body === "Because it is."));
  assert.deepEqual(cleanQuizEvents([{ kind: "verdict", ago: 1 }, { kind: "left", ago: -9 }]), [{ kind: "left", ago: 0 }]);

  // Student's view: results shown on hand-in, with the right answers.
  const view = await studentQuiz(S1, a);
  assert.equal(view?.attempts[0].score, 9);
  assert.ok(view?.attempts[0].results?.some((r) => r.answer === "4"));
  assert.ok(!JSON.stringify(view).includes("\"correct\""));
});

test("quiz: results wait for release when the teacher says so", async () => {
  const quiz = { ...sampleQuiz(), settings: { ...sampleQuiz().settings, results: "on-release" } };
  const a = await quizIn(quiz);
  const st = await startAttempt(S1, a);
  assert.ok(st.ok);
  await saveAttempt(S1, a, st.attempt.id, { baseVersion: st.attempt.version, handIn: true, responses: { q1: "b" } });
  const hidden = await studentQuiz(S1, a);
  assert.equal(hidden?.resultsShown, false);
  assert.equal(hidden?.attempts[0].score, null);
  assert.equal(hidden?.attempts[0].results, null);
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, gradesReleased: true });
  assert.ok(r.ok);
  assert.equal((await studentQuiz(S1, r.assignment))?.resultsShown, true);
});

test("quiz: attempts limit, extra attempts and extra time per student", async () => {
  const a = await quizIn({ ...sampleQuiz(), settings: { attempts: 1, timeLimit: 10 } });
  const one = await startAttempt(S1, a);
  assert.ok(one.ok);
  const mins = (x: { startedAt: string; deadlineAt: string | null }) => Math.round((Date.parse(x.deadlineAt!) - Date.parse(x.startedAt)) / 60_000);
  assert.equal(mins(one.attempt), 10);
  await saveAttempt(S1, a, one.attempt.id, { baseVersion: one.attempt.version, handIn: true, responses: {} });
  assert.deepEqual(await startAttempt(S1, a), { ok: false, reason: "no-attempts" });

  assert.equal(await setAccommodation(T, a.courseId, "stranger", ROSTER, { timeFactor: 2 }), null, "only the class's students");
  await setAccommodation(T, a.courseId, "stu-1", ROSTER, { timeFactor: 1.5, extraAttempts: 1 });
  const two = await startAttempt(S1, a);
  assert.ok(two.ok);
  assert.equal(two.attempt.number, 2);
  assert.equal(mins(two.attempt), 15);
});

test("quiz: the time limit is the server's; a late save is refused and the attempt handed in with what was saved", async () => {
  const a = await quizIn({ ...sampleQuiz(), settings: { attempts: 1, timeLimit: 5 } });
  const st = await startAttempt(S1, a);
  assert.ok(st.ok);
  const s1 = await saveAttempt(S1, a, st.attempt.id, { baseVersion: st.attempt.version, responses: { q1: "b" } });
  assert.ok(s1.ok);
  // Six minutes pass.
  await db.query("UPDATE quiz_attempts SET started_at = started_at - interval '6 minutes', deadline_at = deadline_at - interval '6 minutes' WHERE id = $1", [st.attempt.id]);
  const late = await saveAttempt(S1, a, st.attempt.id, { baseVersion: s1.attempt.version, responses: { q1: "b", q2: "false", q3: "Paris" } });
  assert.equal(late.ok ? "" : late.reason, "time-up");
  assert.ok(!late.ok && late.reason === "time-up" && late.attempt.autoSubmitted);
  const [row] = await attemptsOf(T, a.id, "stu-1");
  assert.deepEqual(row.responses, { q1: "b" }, "nothing after the deadline is kept");
  assert.equal(row.score, 2);
  assert.ok(Date.parse(row.submittedAt!) <= Date.parse(row.deadlineAt!), "handed in at the deadline");

  // An attempt simply left open is closed the next time anyone looks.
  const b = await quizIn({ ...sampleQuiz(), settings: { attempts: 1, timeLimit: 5 } });
  const st2 = await startAttempt(S2, b);
  assert.ok(st2.ok);
  await db.query("UPDATE quiz_attempts SET deadline_at = now() - interval '1 minute' WHERE id = $1", [st2.attempt.id]);
  assert.deepEqual(await closeExpired(T, b), ["stu-2"]);
  assert.ok((await attemptsOf(T, b.id, "stu-2"))[0].autoSubmitted);
});

test("quiz: changing the key regrades every attempt and rewrites grades, keeping the history", async () => {
  const quiz = { settings: { attempts: 1, results: "on-hand-in" }, items: sampleQuiz().items.slice(0, 3) };
  const a = await quizIn(quiz);
  for (const s of [S1, S2]) {
    const st = await startAttempt(s, a);
    assert.ok(st.ok);
    await saveAttempt(s, a, st.attempt.id, { baseVersion: st.attempt.version, handIn: true, responses: { q1: "b", q2: "true", q3: "Paris" } });
    assert.equal(await syncGrade({ ...s, userId: QUIZ_GRADER }, a, s.userId, new Set([s.userId])), true);
  }
  assert.deepEqual((await gradesFor(T, a.id)).map((g) => g.score), [4, 4]);
  // A teacher's comment survives the regrade.
  await setGrade(T, a, "stu-1", ROSTER, { score: 4, comment: "Nice work" });

  const items = quiz.items.map((i) => (i.identifier === "q2" ? { ...i, correct: ["true"] } : i));
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, quiz: { ...quiz, items } });
  assert.ok(r.ok);
  assert.notEqual(scoringKey(a.quiz), scoringKey(r.assignment.quiz));
  const out = await regradeQuiz(T, r.assignment, ROSTER);
  assert.deepEqual(out, { attempts: 2, grades: 2 });
  const grades = await gradesFor(T, a.id);
  assert.deepEqual(grades.map((g) => g.score), [5, 5]);
  assert.equal(grades.find((g) => g.studentId === "stu-1")?.comment, "Nice work");
  const hist = await gradeHistory(T, a.id, "stu-1");
  assert.deepEqual(hist.map((h) => h.score), [5, 4, 4], "every score it ever had");
  assert.equal(hist[hist.length - 1].changedBy, QUIZ_GRADER);

  const analysis = await quizAnalysis(T, r.assignment);
  assert.equal(analysis.students, 2);
  assert.deepEqual(analysis.stats.map((s) => s.percentCorrect), [100, 100, 100]);
});

test("quiz: standards alignment per question or per quiz, levels written in a standards course", async () => {
  const [c] = await myCourses("school-a", [{ id: "qz-sbg", name: "SBG", role: "teacher" }]);
  await setGradingMode(T, c.id, "standards");
  const s1 = await addStandard(T, c.id, "M.1", "Add");
  const s2 = await addStandard(T, c.id, "M.2", "Facts");
  const a0 = await createAssignment(T, c.id, { title: "Q", kind: "quiz" });
  const r = await saveAssignment(T, a0.id, {
    baseVersion: a0.version, published: true,
    quiz: { settings: { results: "on-hand-in" }, items: [
      { identifier: "q1", kind: "truefalse", points: 2, correct: ["true"], standardId: s1!.id },
      { identifier: "q2", kind: "truefalse", points: 2, correct: ["true"], standardId: "99999999-9999-9999-9999-999999999999" },
    ] },
    standards: [s2!.id],
  });
  assert.ok(r.ok);
  const a = r.assignment;
  assert.equal(a.quiz?.items[1].standardId, null, "a standard from elsewhere is dropped");
  assert.deepEqual(alignedStandards(a).sort(), [s1!.id, s2!.id].sort());
  const st = await startAttempt(S1, a);
  assert.ok(st.ok);
  await saveAttempt(S1, a, st.attempt.id, { baseVersion: st.attempt.version, handIn: true, responses: { q1: "true", q2: "false" } });
  await syncGrade({ ...S1, userId: QUIZ_GRADER }, a, "stu-1", new Set(["stu-1"]));
  const [g] = await gradesFor(T, a.id);
  assert.deepEqual(g.levels, { [s1!.id]: 4, [s2!.id]: 2 });
});

test("quiz: another school can't see or answer it", async () => {
  const a = await quizIn();
  assert.equal(await getAssignment({ tenantId: "school-b", userId: "x" }, a.id), null);
  const st = await startAttempt(S1, a);
  assert.ok(st.ok);
  const other = { tenantId: "school-b", userId: "stu-1" };
  assert.deepEqual(await saveAttempt(other, a, st.attempt.id, { baseVersion: st.attempt.version, responses: {} }), { ok: false, reason: "missing" });
  assert.equal((await attemptsOf(other, a.id)).length, 0);
});

test("i18n: quiz strings have Spanish", () => {
  const en = dict("en"), es = dict("es");
  const keys = Object.keys(en).filter((k) => k.startsWith("quiz") || k.startsWith("qk_")) as (keyof typeof en)[];
  assert.ok(keys.length > 40);
  for (const k of keys) assert.notEqual(es[k], en[k], `${k} has no Spanish`);
});
