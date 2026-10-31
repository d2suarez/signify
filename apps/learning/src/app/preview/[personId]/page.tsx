import Link from "next/link";
import { lang } from "@/lib/access";
import { myCourses } from "@/lib/courses";
import { previewFor } from "@/lib/preview";
import { dict } from "@/lib/i18n";
import { PreviewFrame, PreviewFailed } from "@/components/Preview";

export const dynamic = "force-dynamic";

/** The home page as a practice student (their courses) or parent (their children) sees it. */
export default async function PreviewHome({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const L = await lang();
  const d = dict(L);
  const p = await previewFor(personId, "home");
  if (p === "failed") return <PreviewFailed d={d} retry={`/preview/${personId}`} />;
  const { me, who, base } = p;
  // A student's courses: only those a teacher has opened (never created here).
  const courses = who.kind === "student" ? (await myCourses(me.tenantId, who.classes)).filter((c) => c.role === "student") : [];

  return (
    <PreviewFrame p={p} d={d}>
      <h1 style={{ fontSize: 34 }}>{who.kind === "parent" ? d.yourChildren : d.myCourses}</h1>
      {who.kind === "parent" && (
        <>
          {who.children.length === 0 && <p className="empty">{d.noChildren}</p>}
          <div className="grid-cards">
            {who.children.map((c) => (
              <Link key={c.id} href={`${base}/family/${c.id}`} className="card course-card">
                <span className="muted" style={{ fontSize: 13 }}>{d.seeAllWork}</span>
                <h3>{c.display_name}</h3>
              </Link>
            ))}
          </div>
        </>
      )}
      {who.kind === "student" && (
        <>
          {courses.length === 0 && <p className="empty">{d.previewNoCourses}</p>}
          <div className="grid-cards">
            {courses.map((c) => (
              <Link key={c.id} href={`${base}/courses/${c.id}`} className="card course-card">
                <span className="muted" style={{ fontSize: 13 }}>{c.subject || " "}</span>
                <h3>{c.name}</h3>
              </Link>
            ))}
          </div>
        </>
      )}
    </PreviewFrame>
  );
}
