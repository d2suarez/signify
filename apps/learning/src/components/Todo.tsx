import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import type { TeacherTasks, StudentTasks, StudentTask } from "@/lib/tasks";
import { When } from "./When";

/**
 * The home page's "To do": for a teacher, work to grade, work due this
 * week, drafts due soon that students can't see yet, and today's lessons;
 * for a student or parent, overdue and upcoming work. Each group says what
 * it is in words (colour and shape only back that up).
 */
export function TodoPanel({ teacher, student, d, L }: { teacher: TeacherTasks | null; student: StudentTasks; d: Dict; L: Lang }) {
  const hasStudent = student.overdue.length + student.upcoming.length > 0;
  const hasTeacher = !!teacher && teacher.grade.length + teacher.due.length + teacher.drafts.length + teacher.lessons.length > 0;
  return (
    <section className="card side-card todo" aria-labelledby="todo-title">
      <h2 id="todo-title" className="label">{d.todoTitle}</h2>
      {!hasStudent && !hasTeacher && <p className="muted todo-empty">{d.todoNothing}</p>}

      {teacher && teacher.grade.length > 0 && (
        <Group title={d.todoToGrade} count={teacher.grade.reduce((n, t) => n + (t.kind === "grade" ? t.count : 0), 0)} tone="grade">
          {teacher.grade.map((t) => t.kind === "grade" && (
            <Item key={t.id} href={`/assignments/${t.id}/grade`} title={t.title} shape="s-tri"
              sub={<>{t.courseName} · {t.count} {t.count === 1 ? d.todoHandedInOne : d.todoHandedInMany}</>} />
          ))}
        </Group>
      )}
      {teacher && teacher.lessons.length > 0 && (
        <Group title={d.todoToday} tone="today">
          {teacher.lessons.map((t) => (
            <Item key={t.id} href={`/lessons/${t.id}/present`} title={t.title} shape="s-arch" sub={<>{t.courseName} · {d.present}</>} />
          ))}
        </Group>
      )}
      {teacher && teacher.drafts.length > 0 && (
        <Group title={d.todoDrafts} tone="draft">
          {teacher.drafts.map((t) => t.kind === "draft" && (
            <Item key={t.id} href={`/assignments/${t.id}`} title={t.title} shape="s-tri"
              sub={<>{t.courseName} · {new Date(t.dueAt) < new Date() ? d.todoWasDue : d.due} <When iso={t.dueAt} lang={L} /> · {d.pcDraft}</>} />
          ))}
        </Group>
      )}
      {teacher && teacher.due.length > 0 && (
        <Group title={d.todoDueSoon} tone="soon">
          {teacher.due.map((t) => t.kind === "due" && (
            <Item key={t.id} href={`/assignments/${t.id}`} title={t.title} shape="s-tri"
              sub={<>{t.courseName} · {d.due} <When iso={t.dueAt} lang={L} />{t.handedIn > 0 && <> · {t.handedIn} {d.todoIn}</>}</>} />
          ))}
        </Group>
      )}

      {student.overdue.length > 0 && (
        <Group title={d.todoOverdue} count={student.overdue.length} tone="overdue">
          {student.overdue.map((t) => <StudentItem key={`${t.who?.id ?? ""}${t.id}`} t={t} d={d} L={L} />)}
        </Group>
      )}
      {student.upcoming.length > 0 && (
        <Group title={d.todoUpcoming} tone="soon">
          {student.upcoming.map((t) => <StudentItem key={`${t.who?.id ?? ""}${t.id}`} t={t} d={d} L={L} />)}
        </Group>
      )}
    </section>
  );
}

function Group({ title, count, tone, children }: { title: string; count?: number; tone: string; children: React.ReactNode }) {
  return (
    <div className={`todo-group todo-${tone}`}>
      <h3 className="todo-head">{title}{count !== undefined && count > 0 && <span className="todo-count">{count}</span>}</h3>
      <ul className="todo-list">{children}</ul>
    </div>
  );
}

function Item({ href, title, sub, shape }: { href: string; title: string; sub: React.ReactNode; shape: string }) {
  return (
    <li>
      <Link href={href} className="todo-item">
        <span className={`shape ${shape}`} aria-hidden="true" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="todo-title">{title}</span>
          <span className="muted todo-sub">{sub}</span>
        </span>
      </Link>
    </li>
  );
}

function StudentItem({ t, d, L }: { t: StudentTask; d: Dict; L: Lang }) {
  // A parent's list goes to that child's page; a student's to the work itself.
  const href = t.who ? `/family/${t.who.id}` : `/assignments/${t.id}`;
  const status = t.status === "missing" ? d.todoMissing : t.status === "overdue" ? d.todoLate : t.status === "inClass" ? d.todoInClass : null;
  return (
    <Item href={href} title={t.title} shape="s-tri"
      sub={<>{t.who ? `${t.who.name} · ` : ""}{t.courseName}{t.dueAt && <> · {d.due} <When iso={t.dueAt} lang={L} /></>}{status && <> · <strong>{status}</strong></>}</>} />
  );
}
