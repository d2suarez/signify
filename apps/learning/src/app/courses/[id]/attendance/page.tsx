import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { AttendanceError, STATUSES, asStatus, classDay, statusWord, takeAttendance, type Status } from "@/lib/attendance";
import { addDays, addSchoolDays, isSchoolDay, parseDay, todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import { When } from "@/components/When";

export const dynamic = "force-dynamic";

/**
 * Attendance for one class meeting (story 01, D6): the class from Signify
 * ID, each student Present / Absent / Tardy / Excused with a note, saved as
 * the school's record. Works without JavaScript (one form).
 */

async function save(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const day = String(formData.get("day") || "");
  const base = `/courses/${access.course.id}/attendance?day=${encodeURIComponent(day)}`;
  const { ok, students } = await studentsOf(access);
  if (!ok) redirect(`${base}&m=roster`);
  const marks = students.map((s) => ({ studentId: s.id, status: asStatus(formData.get(`s:${s.id}`)), note: formData.get(`n:${s.id}`) }));
  try {
    await takeAttendance(ctx(access.me), access.course.id, day, todayIn(SCHOOL_TZ), marks, new Map(students.map((s) => [s.id, s.name])));
  } catch (e) {
    if (e instanceof AttendanceError) redirect(`${base}&m=${e.code}`);
    throw e;
  }
  redirect(`${base}&m=saved`);
}

export default async function AttendancePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ day?: string; m?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const { day: asked, m } = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const today = todayIn(SCHOOL_TZ);
  // Today, or the last school day before it at a weekend; never a day to come.
  let day = parseDay(asked) ?? today;
  if (day > today) day = today;
  while (!isSchoolDay(day)) day = addDays(day, -1);
  const prev = addSchoolDays(day, -1);
  const next = addSchoolDays(day, 1);

  const [{ ok, students }, marks] = await Promise.all([studentsOf(access), classDay(ctx(me), course.id, day)]);
  const taken = marks.size > 0;
  const last = [...marks.values()].reduce<string | null>((a, x) => (!a || x.markedAt > a ? x.markedAt : a), null);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, [...marks.values()].filter((x) => x.status === s).length])) as Record<Status, number>;

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <CourseNav courseId={course.id} current="attendance" d={d} club={course.kind === "club"} />

        <section className="card stack" aria-labelledby="att-title" style={{ gap: 12 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 id="att-title" style={{ fontSize: 24, flex: "1 1 12em", minWidth: 0 }}>
              {d.attTitle} · <When iso={`${day}T12:00:00Z`} withTime={false} lang={L} />
            </h2>
            <Link className="btn btn-sm" href={`/courses/${course.id}/attendance?day=${prev}`}>← {d.attPrevDay}</Link>
            {day < today && <Link className="btn btn-sm" href={`/courses/${course.id}/attendance?day=${next}`}>{d.attNextDay} →</Link>}
            {day !== today && <Link className="btn btn-sm" href={`/courses/${course.id}/attendance`}>{d.attToday}</Link>}
          </div>
          <p className="muted" style={{ margin: 0 }} role="status">
            {taken
              ? <>{d.attTaken} <When iso={last} lang={L} /> · {STATUSES.map((s) => `${statusWord(s, d)} ${counts[s]}`).join(" · ")}</>
              : d.attNotTaken}
          </p>
          {m === "saved" && <p className="notice" role="status" style={{ margin: 0 }}>{d.attSaved}</p>}
          {m === "roster" && <p className="notice" role="alert" style={{ margin: 0 }}>{d.attRosterFailed}</p>}
          {(m === "day" || m === "future") && <p className="notice" role="alert" style={{ margin: 0 }}>{d.attBadDay}</p>}

          {!ok ? <p className="notice" role="alert" style={{ margin: 0 }}>{d.attRosterFailed}</p>
            : students.length === 0 ? <p className="empty">{d.attNoStudents}</p> : (
            <form action={save} className="stack" style={{ gap: 10 }}>
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="day" value={day} />
              <ul className="att-list">
                {students.map((s) => {
                  const had = marks.get(s.id);
                  const now = had?.status ?? "present";
                  return (
                    <li key={s.id} className="att-row">
                      <fieldset className="choice">
                        <legend>{s.name}{!had && taken && <span className="muted" style={{ fontWeight: 400 }}> · {d.attNotMarked}</span>}</legend>
                        <div className="choice-opts">
                          {STATUSES.map((st) => (
                            <label key={st}>
                              <input type="radio" name={`s:${s.id}`} value={st} defaultChecked={now === st} />
                              <span>{statusWord(st, d)}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="fieldset" style={{ margin: 0 }}>
                        <label htmlFor={`n-${s.id}`} className="sr-only">{d.attNoteFor.replace("{name}", s.name)}</label>
                        <input id={`n-${s.id}`} name={`n:${s.id}`} className="field" maxLength={300} defaultValue={had?.note ?? ""} placeholder={d.attNote} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {!taken && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.attDefaultHint}</p>}
              <div><button type="submit" className="btn btn-primary">{taken ? d.attUpdate : d.attSave}</button></div>
            </form>
          )}
        </section>
      </main>
    </>
  );
}
