import Link from "next/link";
import type { ReactNode } from "react";
import type { Dict } from "@/lib/i18n";
import type { Preview } from "@/lib/preview";
import { TopBar } from "./TopBar";

/**
 * Every preview page's frame: the top bar with a banner that stays on screen
 * saying whose view this is and that it is read-only, and the way back.
 */
export function PreviewFrame({ p, d, crumbs, children }: { p: Preview; d: Dict; crumbs?: ReactNode; children: ReactNode }) {
  const { who, base } = p;
  const banner = (
    <div className="preview-band" role="status">
      <div className="top-in">
        <b>{d.previewBanner.replace("{name}", who.display_name)}</b>
        <span className="muted">{who.kind === "parent" ? d.previewParentHint : d.previewStudentHint}</span>
        <span className="spacer" />
        <nav className="row" style={{ gap: 6 }} aria-label={d.previewAs}>
          <Link className="btn btn-sm" href={base}>{d.previewHome}</Link>
          <Link className="btn btn-sm" href={`${base}/week`}>{d.thisWeek}</Link>
          {who.kind === "student" && <Link className="btn btn-sm" href={`${base}/grades`}>{d.previewGrades}</Link>}
          <Link className="btn btn-sm" href="/preview">{d.previewExit}</Link>
        </nav>
      </div>
    </div>
  );
  return (
    <>
      <TopBar crumbs={crumbs ?? <Link href={base}>{who.display_name}</Link>} below={banner} />
      <main className="page stack">{children}</main>
    </>
  );
}

/** Signify ID couldn't be asked who may be previewed. */
export function PreviewFailed({ d, retry }: { d: Dict; retry: string }) {
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack">
        <div className="notice notice-bad" role="alert">{d.previewFailed} <a href={retry}>{d.tryAgain}</a></div>
      </main>
    </>
  );
}
