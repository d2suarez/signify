import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { lang } from "@/lib/access";
import { myPreviewPeople } from "@/lib/preview";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { PreviewFailed } from "@/components/Preview";

export const dynamic = "force-dynamic";

/** Whom the signed-in teacher or school admin may preview (Signify ID decides). */
export default async function PreviewIndex() {
  const me = await requireMe();
  const d = dict(await lang());
  const { ok, people } = await myPreviewPeople();
  if (!ok) return <PreviewFailed d={d} retry="/preview" />;
  console.info(`learning: preview ${me.id} listed ${people.length} practice people`);
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <h1 style={{ fontSize: 34 }}>{d.previewTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.previewIntro}</p>
        {people.length === 0 && <p className="empty">{d.previewNone}</p>}
        <div className="grid-cards">
          {people.map((p) => (
            <Link key={p.id} href={`/preview/${p.id}`} className="card course-card">
              <span className="muted" style={{ fontSize: 13 }}>{p.kind === "parent" ? d.previewPracticeParent : d.previewPracticeStudent}</span>
              <h3>{p.display_name}</h3>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
