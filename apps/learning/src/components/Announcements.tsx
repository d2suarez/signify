import type { Announcement } from "@/lib/announcements";
import type { Dict, Lang } from "@/lib/i18n";
import { When } from "./When";

/**
 * A course's announcements. With `archive` (the teacher's course page), each
 * has a Take down button; without it (students, parents, previews) it is a
 * plain list.
 */
export function Announcements({ list, L, d, courseId, archive }: {
  list: Announcement[]; L: Lang; d: Dict; courseId: string; archive?: (formData: FormData) => Promise<void>;
}) {
  if (!list.length) return archive ? <p className="empty" style={{ margin: 0 }}>{d.noAnnouncements}</p> : null;
  return (
    <ul className="list announcements">
      {list.map((a) => (
        <li key={a.id} style={{ alignItems: "flex-start" }}>
          <span className="shape s-square" aria-hidden="true" style={{ marginTop: 6 }} />
          <div className="grow">
            {a.title && <h3>{a.title}</h3>}
            <p style={{ whiteSpace: "pre-wrap", margin: a.title ? "4px 0 0" : 0 }}>{a.body}</p>
            <span className="muted" style={{ fontSize: 13 }}><When iso={a.createdAt} lang={L} /></span>
          </div>
          {archive && (
            <form action={archive}>
              <input type="hidden" name="courseId" value={courseId} />
              <input type="hidden" name="announcementId" value={a.id} />
              <button className="btn btn-sm" name="op" value="archive" aria-label={`${d.takeDown}: ${a.title || a.body.slice(0, 40)}`}>{d.takeDown}</button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
