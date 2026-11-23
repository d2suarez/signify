import Link from "next/link";
import type { ReactNode } from "react";
import { readMe } from "@/lib/auth";
import { lang, myPrefs } from "@/lib/access";
import { dict } from "@/lib/i18n";
import Supports from "./Supports";
import CourseDrawer, { type DrawerWords } from "./CourseDrawer";

const DRAWER_KEYS = ["cdButton", "cdTitle", "cdHint", "cdFilter", "cdNoMatch", "cdLoading", "cdFailed", "cdHere", "cdGoHome", "close", "tryAgain",
  "teaching", "learning", "clubsTitle", "yourChildren", "seeAllWork", "liveNow", "joinLive", "liveNowJoin", "covering", "clubSponsors", "clubLabel",
  "noCourses", "childrenFailed"] as const;

export function Marks() {
  return (
    <span className="marks" aria-hidden="true">
      <span className="shape s-circle" style={{ width: 10, height: 10 }} />
      <span className="shape s-square" style={{ width: 10, height: 10 }} />
      <span className="shape s-tri" style={{ width: 10, height: 10 }} />
      <span className="shape s-arch" style={{ width: 10, height: 10 }} />
    </span>
  );
}

/** `below` sits under the bar and stays with it (the preview banner). */
export async function TopBar({ crumbs, right, below }: { crumbs?: ReactNode; right?: ReactNode; below?: ReactNode }) {
  // Reading supports are on every signed-in page, so a student never has to hunt for them.
  const me = await readMe();
  const d = dict(await lang());
  const supports = me ? <Supports initial={await myPrefs()} d={d} /> : null;
  return (
    <header className="top">
      <div className="top-in">
        {/* Every class, club and child, from any page (asked for when it opens). */}
        {me && <CourseDrawer w={Object.fromEntries(DRAWER_KEYS.map((k) => [k, d[k]])) as DrawerWords} />}
        <Link href="/" className="brand">
          <Marks />
          <span className="brand-name">Signify Learning</span>
        </Link>
        {crumbs ? <nav className="crumbs" aria-label={d.whereYouAre}>{crumbs}</nav> : null}
        <span className="spacer" />
        {/* On narrow screens the rail is below the page; this goes straight to it (hidden where there's no rail). */}
        {me && <a className="btn btn-sm rail-jump" href="#rail" aria-label={d.wgJump}>{d.wgTools} ↓</a>}
        {supports}
        {right}
      </div>
      {below}
    </header>
  );
}
