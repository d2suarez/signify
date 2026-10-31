import Link from "next/link";
import { notFound } from "next/navigation";
import { ctx, lang } from "@/lib/access";
import { previewFor } from "@/lib/preview";
import { studentWork } from "@/lib/family";
import { dict } from "@/lib/i18n";
import { PreviewFrame, PreviewFailed } from "@/components/Preview";
import { CourseWorkCard } from "@/components/Work";

export const dynamic = "force-dynamic";

/** The parent view of one child, as the practice parent sees it. */
export default async function PreviewChild({ params }: { params: Promise<{ personId: string; childId: string }> }) {
  const { personId, childId } = await params;
  const L = await lang();
  const d = dict(L);
  const p = await previewFor(personId, `child ${childId}`);
  if (p === "failed") return <PreviewFailed d={d} retry={`/preview/${personId}/family/${childId}`} />;
  const { me, who, base } = p;
  if (who.kind !== "parent") notFound();
  // Only a child Signify ID links (verified) to this parent.
  const child = who.children.find((k) => k.id === childId);
  if (!child) notFound();
  const work = await studentWork(ctx(me), child.classes, child.id);

  return (
    <PreviewFrame p={p} d={d} crumbs={<><Link href={base}>{who.display_name}</Link><span aria-hidden="true"> / </span><span>{child.display_name}</span></>}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <h1 style={{ fontSize: 34 }} className="grow">{child.display_name}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>{d.parentNote}</p>
      {work.length === 0 && <p className="empty">{d.noCoursesChild}</p>}
      {work.map((w) => <CourseWorkCard key={w.course.id} w={w} d={d} L={L} />)}
    </PreviewFrame>
  );
}
