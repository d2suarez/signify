import Link from "next/link";
import type { Course, CourseRole } from "@/lib/courses";
import type { Dict } from "@/lib/i18n";
import { CourseNav, type CourseTab } from "./CourseNav";
import ClassHeadShrink from "./ClassHeadShrink";
import ClassPicture from "./ClassPicture";

/**
 * The one class header on every page inside a class (Desmond, 2026-11-23:
 * "No matter where a user navigates to within a class, the name of the
 * class needs to be at the top of the page", with the teacher's picture to
 * its left). It goes in the top bar's `below` slot, so it stays at the top
 * and is the same size and place on every page whatever the page's own
 * width; it gets smaller once the page scrolls and on narrow screens.
 * Teachers also get the class's tabs (CourseNav) and a button to put up or
 * change the picture.
 *
 * `tab` = which tab this page is (null: a page inside the class that is no
 * tab, such as a lesson); `heading` makes the class name the page's h1 (the
 * tab pages, whose own title is the class).
 */
export function ClassHeader({ course, d, tab = null, heading = false, tabs = true }: {
  course: Pick<Course, "id" | "name" | "subject" | "kind" | "pictureFileId"> & { role: CourseRole };
  d: Dict; tab?: CourseTab | null; heading?: boolean; tabs?: boolean;
}) {
  const teacher = course.role === "teacher";
  const club = course.kind === "club";
  const Name = heading ? "h1" : "p";
  const initial = (course.name.trim()[0] || "?").toUpperCase();
  const kicker = club ? d.clubLabel : course.subject;
  return (
    <div className="class-head">
      <div className="class-head-in">
        <div className="class-pic">
          {course.pictureFileId
            // eslint-disable-next-line @next/next/no-img-element -- our own checked file; decorative, the name is beside it
            ? <img src={`/files/${course.pictureFileId}`} alt="" />
            : <span className="class-pic-none" aria-hidden="true">{initial}</span>}
          {teacher && (
            <ClassPicture courseId={course.id} has={!!course.pictureFileId} compact
              w={{ cpChange: d.cpChange, cpAdd: d.cpAdd, cpRemove: d.cpRemove, cpBusy: d.cpBusy, cpFailed: d.cpFailed, cpRefused: d.cpRefused, cpOff: d.cpOff, cpHint: d.cpHint }} />
          )}
        </div>
        <div className="class-head-text">
          {kicker && <span className="class-head-kicker">{kicker}</span>}
          <Name className="class-head-name"><Link href={`/courses/${course.id}`} aria-current={tab === "plan" ? "page" : undefined}>{course.name}</Link></Name>
        </div>
      </div>
      {teacher && tabs && (
        <div className="class-head-tabs"><CourseNav courseId={course.id} current={tab} d={d} club={club} /></div>
      )}
      <ClassHeadShrink />
    </div>
  );
}
