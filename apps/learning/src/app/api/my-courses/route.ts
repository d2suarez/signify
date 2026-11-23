import { NextResponse } from "next/server";
import { readMe, myClasses, myChildren } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { liveJoinHref } from "@/lib/live-ticket";

export const dynamic = "force-dynamic";

export type DrawerCourse = { id: string; name: string; sub: string; href: string; live: boolean; liveHref: string | null; covering: boolean; role: "teacher" | "student"; club: boolean };
export type DrawerData = {
  ok: boolean;
  childrenOk: boolean;
  /** A guardian, or anyone Signify ID gives children (as on the home page). */
  parent: boolean;
  teaching: DrawerCourse[];
  learning: DrawerCourse[];
  clubs: DrawerCourse[];
  children: { id: string; name: string; href: string }[];
};

/**
 * The top bar's Courses drawer (components/CourseDrawer.tsx): the same
 * classes, clubs and children as the home page, asked for only when the
 * drawer opens so other pages pay nothing for it. Signify ID's answers are
 * cached a minute (auth.ts).
 */
export async function GET() {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const [{ ok, classes }, family] = await Promise.all([myClasses(), myChildren()]);
  const courses = await myCourses(me.tenantId, classes, me.id);
  const one = (c: (typeof courses)[number]): DrawerCourse => {
    const liveHref = liveJoinHref(c.id, c.role);
    return {
      id: c.id, name: c.name, sub: [c.subject, c.schoolYear].filter(Boolean).join(" · "),
      href: `/courses/${c.id}`,
      live: !!liveHref, liveHref, covering: c.covering, role: c.role, club: c.kind === "club",
    };
  };
  const data: DrawerData = {
    ok,
    childrenOk: family.ok,
    parent: me.role === "guardian" || family.children.length > 0,
    teaching: courses.filter((c) => c.role === "teacher" && c.kind !== "club").map(one),
    learning: courses.filter((c) => c.role === "student" && c.kind !== "club").map(one),
    clubs: courses.filter((c) => c.kind === "club").map(one),
    children: family.children.map((k) => ({ id: k.id, name: k.display_name, href: `/family/${k.id}` })),
  };
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
