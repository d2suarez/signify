import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { lang, updatesViewer } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { feed } from "@/lib/updates";
import { TopBar } from "@/components/TopBar";
import { Feed, Composer, UpdateErrorNote } from "@/components/Updates";

export const dynamic = "force-dynamic";

/** Every update this person can read: the whole school's and their classes' and clubs' (a parent: their children's). */
export default async function UpdatesPage({ searchParams }: { searchParams: Promise<{ updateError?: string; show?: string }> }) {
  await requireMe();
  const sp = await searchParams;
  const L = await lang();
  const d = dict(L);
  const v = (await updatesViewer())!;
  const school = sp.show === "school";
  const posts = await feed(v, school ? { school: true } : {}, 60);
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack">
        <h1 style={{ fontSize: 34 }}>{d.updTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{v.kind === "parent" ? d.updParentHint : d.updHint}</p>
        <nav className="tabs" aria-label={d.updTitle}>
          <Link href="/updates" aria-current={!school ? "page" : undefined}>{d.updEverything}</Link>
          <Link href="/updates?show=school" aria-current={school ? "page" : undefined}>{d.updWholeSchool}</Link>
        </nav>
        <UpdateErrorNote code={sp.updateError} d={d} />
        {v.canPostSchool && (
          <section className="card stack" aria-labelledby="school-post" style={{ gap: 8 }}>
            <h2 id="school-post" className="label">{d.updToSchool}</h2>
            <Composer courseId={null} back={school ? "/updates?show=school" : "/updates"} d={d} label={d.updWriteSchool} />
          </section>
        )}
        <section className="card">
          <Feed posts={posts} back={school ? "/updates?show=school" : "/updates"} L={L} d={d} />
        </section>
      </main>
    </>
  );
}
