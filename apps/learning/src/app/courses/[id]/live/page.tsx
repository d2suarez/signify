import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, lang } from "@/lib/access";
import { dict, t } from "@/lib/i18n";
import { signTicket } from "@/lib/live-ticket";
import { TopBar } from "@/components/TopBar";
import Follower from "@/components/Follower";

export const dynamic = "force-dynamic";

export default async function FollowLive({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  // A teacher opening this page sees what students see, without the answer
  // key and without being able to move the lesson.
  const ticket = signTicket({ sub: me.id, name: me.name, course: course.id, role: "student" });
  return (
    <>
      <TopBar crumbs={<Link href="/">{t("myCourses", L)}</Link>} />
      <main className="page">
        <Follower courseId={course.id} courseName={course.name} ticket={ticket} d={dict(L)} />
      </main>
    </>
  );
}
