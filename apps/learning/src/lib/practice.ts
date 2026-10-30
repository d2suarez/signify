import { getDb } from "./db";
import { createUnit } from "./units";
import { createLesson } from "./lessons";
import { createAssignment, getAssignment, saveAssignment } from "./assignments";
import { setGrade } from "./grades";
import { postAnnouncement } from "./announcements";
import type { Block } from "./blocks";

/**
 * Sample work for a practice course, so a teacher can see what students and
 * parents see before there is real data. Only a course whose Signify ID
 * class is named "Practice …" (Signify ID's practice class is "Practice —
 * Demo class") can be filled or cleared, so a real course can never be
 * emptied by this.
 *
 * Filling clears first, then writes: two units, three lessons, a written
 * assignment, a paper worksheet with grades released, a quiz with grades not
 * yet released, and an announcement. Grades go through setGrade with the
 * class's live roster, like a teacher's own, so they are only ever written
 * for students Signify ID lists in the class.
 */

type Ctx = { tenantId: string; userId: string };

export function isPracticeCourse(c: { name: string }): boolean {
  return /^practice\b/i.test(c.name.trim());
}

/** Everything in the course goes: units, lessons, assignments (with their grades and submissions), announcements, categories, standards. */
export async function clearPractice(ctx: Ctx, courseId: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    for (const table of ["assignments", "lessons", "units", "announcements", "grade_categories", "standards"]) {
      await t.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND course_id = $2`, [ctx.tenantId, courseId]);
    }
  });
}

const day = (offset: number, from = new Date()) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
// 11:59 pm on that day in the school's time zone.
const dueAt = (on: string) => {
  const noon = new Date(`${on}T12:00:00Z`);
  const wall = (tz: string) => new Date(noon.toLocaleString("en-US", { timeZone: tz })).getTime();
  const offsetMs = wall(process.env.SCHOOL_TZ || "America/New_York") - wall("UTC");
  return new Date(new Date(`${on}T23:59:00Z`).getTime() - offsetMs).toISOString();
};

const text = (id: string, title: string, body: string): Block => ({ id, type: "text", title, body });

export async function fillPractice(
  ctx: Ctx, courseId: string, students: string[], now = new Date(),
): Promise<{ units: number; lessons: number; assignments: number; grades: number }> {
  await clearPractice(ctx, courseId);
  const roster = new Set(students);

  const u1 = await createUnit(ctx, courseId, "Unit 1 · Getting started");
  const u2 = await createUnit(ctx, courseId, "Unit 2 · Trying a quiz");

  await createLesson(ctx, courseId, "Welcome to the practice class", [
    text("b1", "This class is pretend", "Everyone here except you and your test accounts is made up. Nothing you do in this class counts."),
    { id: "b2", type: "poll", question: "Which do you like best?", results: "on-reveal",
      choices: [{ id: "c1", text: "Reading", correct: false }, { id: "c2", text: "Maths", correct: false }, { id: "c3", text: "Music", correct: false }] },
    { id: "b3", type: "timer", label: "Think quietly", seconds: 60 },
  ], u1.id);
  await createLesson(ctx, courseId, "How grading works here", [
    text("b1", "Points and letters", "Each assignment is worth points. Your course grade is the points you earned out of the points possible, and the letter comes from that percent."),
    text("b2", "When you see a grade", "You see a grade once your teacher releases it. Your parents see the same released grades."),
  ], u1.id);
  await createLesson(ctx, courseId, "Before the quiz", [
    text("b1", "What the quiz covers", "Three short questions about this practice class. Take it as many times as you like."),
  ], u2.id);

  const publish = async (id: string, input: Record<string, unknown>) => {
    const a = await getAssignment(ctx, id);
    const r = await saveAssignment(ctx, id, { baseVersion: a!.version, ...input });
    if (!r.ok) throw new Error(`practice: could not save ${id}: ${r.reason}`);
    return r.assignment;
  };

  // Paper worksheet, due last week, graded and released.
  const wsDue = day(-6, now);
  const ws = await publish((await createAssignment(ctx, courseId, { title: "Practice worksheet", unitId: u1.id, kind: "offline" })).id, {
    instructions: "A worksheet done in class on paper. Its grades are already released, so students and parents can see them.",
    points: 10, dueOn: wsDue, dueAt: dueAt(wsDue), published: true, gradesReleased: true,
  });
  // Written online, due later this week: nothing handed in yet.
  const wrDue = day(4, now);
  await publish((await createAssignment(ctx, courseId, { title: "Write about your week", unitId: u1.id, kind: "online" })).id, {
    instructions: "Write three or four sentences about your week. Your teacher can see how the writing grew, so type it here rather than pasting it in.",
    points: 10, dueOn: wrDue, dueAt: dueAt(wrDue), published: true,
  });
  // A quiz, due soon; the made-up students' scores are in but not released.
  const qDue = day(2, now);
  const quiz = await publish((await createAssignment(ctx, courseId, { title: "Practice quiz", unitId: u2.id, kind: "quiz" })).id, {
    instructions: "Three questions. Try it as a student.",
    dueOn: qDue, dueAt: dueAt(qDue), published: true,
    quiz: {
      settings: { attempts: 0, keep: "highest", timeLimit: null, shuffleItems: false, shuffleChoices: false, results: "on-hand-in", showAnswers: true },
      items: [
        { identifier: "q1", kind: "single", prompt: "What is this class for?", points: 1, correct: ["a"],
          choices: [{ identifier: "a", text: "Practising" }, { identifier: "b", text: "Real grades" }, { identifier: "c", text: "Nothing" }] },
        { identifier: "q2", kind: "truefalse", prompt: "The other students in this class are made up.", points: 1, correct: ["true"],
          choices: [{ identifier: "true", text: "True" }, { identifier: "false", text: "False" }] },
        { identifier: "q3", kind: "short", prompt: "Type the word 'practice'.", points: 1, correct: ["practice"] },
      ],
    },
  });

  await postAnnouncement(ctx, courseId, {
    title: "Welcome",
    body: "This is a practice class with made-up students. Look around as a student or a parent: nothing here is real.",
  });

  // Grades: a spread on the worksheet (one missing, one late) and quiz scores.
  const wsMarks: Array<{ score: number | null; flag: "missing" | "late" | null; comment: string }> = [
    { score: 9, flag: null, comment: "Neat work." },
    { score: 7, flag: "late", comment: "" },
    { score: null, flag: "missing", comment: "" },
    { score: 10, flag: null, comment: "" },
    { score: 8, flag: null, comment: "Check question 4." },
  ];
  let grades = 0;
  const ordered = [...roster].sort();
  for (let i = 0; i < ordered.length; i++) {
    const r = await setGrade(ctx, ws, ordered[i], roster, wsMarks[i % wsMarks.length]);
    if (r.ok && r.changed) grades++;
  }
  for (let i = 0; i < ordered.length; i++) {
    if (i % 3 === 2) continue; // some have not taken it yet
    const r = await setGrade(ctx, quiz, ordered[i], roster, { score: [3, 2, 1][i % 3], flag: null, comment: "" });
    if (r.ok && r.changed) grades++;
  }
  return { units: 2, lessons: 3, assignments: 3, grades };
}
