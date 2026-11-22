import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { lang, updatesViewer } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { feed } from "@/lib/updates";
import { TopBar } from "@/components/TopBar";
import { Feed, UpdateErrorNote } from "@/components/Updates";
import PostComposer from "@/components/PostComposer";
import { composerSetup } from "@/lib/composer";
import { myCourses } from "@/lib/courses";
import { myClasses } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Every update this person can read: the whole school's and their classes' and clubs' (a parent: their children's). */
export default async function UpdatesPage({ searchParams }: { searchParams: Promise<{ updateError?: string; show?: string }> }) {
  const me = await requireMe();
  const sp = await searchParams;
  const L = await lang();
  const d = dict(L);
  const v = (await updatesViewer())!;
  const school = sp.show === "school";
  const { classes } = await myClasses();
  const [posts, setup] = await Promise.all([
    feed(v, school ? { school: true } : {}, 60),
    myCourses(me.tenantId, classes, me.id).then((mine) => composerSetup(v, mine, d.updWholeSchool)),
  ]);
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack updates-page">
        <h1 style={{ fontSize: 34 }}>{d.updTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{v.kind === "parent" ? d.updParentHint : d.updHint}</p>
        <nav className="tabs" aria-label={d.updTitle}>
          <Link href="/updates" aria-current={!school ? "page" : undefined}>{d.updEverything}</Link>
          <Link href="/updates?show=school" aria-current={school ? "page" : undefined}>{d.updWholeSchool}</Link>
        </nav>
        <UpdateErrorNote code={sp.updateError} d={d} />
        {setup.places.length > 0 && (
          <div className="card composer-card">
            <PostComposer places={setup.places} preselected={school && v.canPostSchool ? ["school"] : []} materials={setup.materials}
              canUpload={setup.canUpload} uploadFallback={setup.uploadFallback} d={d}
              placeholder={school ? d.updWriteSchool : d.pcPlaceholderTeacher} back={school ? "/updates?show=school" : "/updates"} />
          </div>
        )}
        <Feed posts={posts} back={school ? "/updates?show=school" : "/updates"} L={L} d={d} cards />
      </main>
    </>
  );
}
