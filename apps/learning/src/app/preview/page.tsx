import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { lang } from "@/lib/access";
import { myPreviewPeople } from "@/lib/preview";
import { dict, type Dict } from "@/lib/i18n";
import type { PreviewPerson } from "@/lib/roster";
import { TopBar } from "@/components/TopBar";
import { PreviewFailed } from "@/components/Preview";

export const dynamic = "force-dynamic";

/**
 * Whom the signed-in teacher or school admin may preview (Signify ID decides):
 * the practice people, then real students and parents. An admin may see a
 * whole school, so there is a name search (a plain GET form, nothing saved).
 */
export default async function PreviewIndex({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const me = await requireMe();
  const d = dict(await lang());
  const q = String((await searchParams).q || "").trim().slice(0, 80);
  const { ok, people } = await myPreviewPeople();
  if (!ok) return <PreviewFailed d={d} retry="/preview" />;
  console.info(`learning: preview ${me.id} listed ${people.length} people`);
  const shown = q ? people.filter((p) => p.display_name.toLowerCase().includes(q.toLowerCase())) : people;
  const practice = shown.filter((p) => p.mock);
  const students = shown.filter((p) => !p.mock && p.kind === "student");
  const parents = shown.filter((p) => !p.mock && p.kind === "parent");
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <h1 style={{ fontSize: 34 }}>{d.previewTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.previewIntro}</p>
        {people.length === 0 && <p className="empty">{d.previewNone}</p>}
        {people.length > 8 && (
          <form method="get" className="row" style={{ gap: 8 }} role="search">
            <input type="search" name="q" defaultValue={q} aria-label={d.previewSearch} placeholder={d.previewSearch} />
            <button className="btn btn-sm" type="submit">{d.previewSearchGo}</button>
          </form>
        )}
        {people.length > 0 && shown.length === 0 && <p className="empty">{d.previewNoMatch}</p>}
        <Group title={d.previewGroupPractice} hint={d.previewGroupPracticeHint} people={practice} d={d} />
        <Group title={d.previewGroupStudents} people={students} d={d} />
        <Group title={d.previewGroupParents} people={parents} d={d} />
      </main>
    </>
  );
}

function Group({ title, hint, people, d }: { title: string; hint?: string; people: PreviewPerson[]; d: Dict }) {
  if (people.length === 0) return null;
  const label = (p: PreviewPerson) =>
    p.mock ? (p.kind === "parent" ? d.previewPracticeParent : d.previewPracticeStudent) : (p.kind === "parent" ? d.previewParent : d.previewStudent);
  return (
    <section className="stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {hint && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{hint}</p>}
      <div className="grid-cards">
        {people.map((p) => (
          <Link key={p.id} href={`/preview/${p.id}`} className="card course-card">
            <span className="muted" style={{ fontSize: 13 }}>{label(p)}</span>
            <h3>{p.display_name}</h3>
          </Link>
        ))}
      </div>
    </section>
  );
}
