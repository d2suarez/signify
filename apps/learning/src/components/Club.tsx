import type { Dict, Lang } from "@/lib/i18n";
import type { ClubEvent } from "@/lib/clubs";
import { EVENT_LIMITS } from "@/lib/clubs";
import type { IdMember } from "@/lib/roster";
import { switchKind, eventAction } from "@/app/courses/[id]/club-actions";

function when(e: ClubEvent, L: Lang): string {
  const day = new Date(`${e.onDay}T12:00:00Z`).toLocaleDateString(L === "es" ? "es" : "en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  if (!e.startTime) return day;
  const [h, m] = e.startTime.split(":").map(Number);
  const time = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(L === "es" ? "es" : "en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day} · ${time}`;
}

/** A club's dates: upcoming first. Sponsors add and remove them. */
export function ClubEvents({ courseId, events, sponsor, L, d, error }: {
  courseId: string; events: { upcoming: ClubEvent[]; past: ClubEvent[] }; sponsor: boolean; L: Lang; d: Dict; error?: string;
}) {
  const row = (e: ClubEvent) => (
    <li key={e.id} style={{ alignItems: "flex-start" }}>
      <span className="shape s-circle" aria-hidden="true" style={{ marginTop: 6 }} />
      <div className="grow">
        <strong>{e.title}</strong>
        <div className="muted" style={{ fontSize: 14 }}>{when(e, L)}{e.place ? ` · ${e.place}` : ""}</div>
        {e.notes && <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{e.notes}</p>}
      </div>
      {sponsor && (
        <form action={eventAction}>
          <input type="hidden" name="courseId" value={courseId} />
          <input type="hidden" name="eventId" value={e.id} />
          <button className="btn btn-sm" name="op" value="archive" aria-label={`${d.clubRemoveEvent}: ${e.title}`}>{d.clubRemoveEvent}</button>
        </form>
      )}
    </li>
  );
  return (
    <section className="card stack" aria-labelledby="club-events" style={{ gap: 10 }}>
      <h2 id="club-events" className="label">{d.clubEvents}</h2>
      {error && <div className="notice notice-bad" role="alert">{error === "day" ? d.clubEventDayErr : d.clubEventTitleErr}</div>}
      {events.upcoming.length === 0 ? <p className="empty" style={{ margin: 0 }}>{d.clubNoEvents}</p> : <ul className="list">{events.upcoming.map(row)}</ul>}
      {events.past.length > 0 && (
        <details>
          <summary className="label" style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>{d.clubPastEvents} ({events.past.length})</summary>
          <ul className="list">{events.past.map(row)}</ul>
        </details>
      )}
      {sponsor && (
        <form action={eventAction} className="stack" style={{ gap: 8 }}>
          <input type="hidden" name="courseId" value={courseId} />
          <h3 className="label" style={{ margin: 0 }}>{d.clubAddEvent}</h3>
          <div className="row">
            <label className="stack" style={{ gap: 4, flex: "2 1 220px" }}><span className="label">{d.title}</span>
              <input name="title" className="field" maxLength={EVENT_LIMITS.title} required /></label>
            <label className="stack" style={{ gap: 4, flex: "1 1 160px" }}><span className="label">{d.clubEventDay}</span>
              <input name="onDay" type="date" className="field" required /></label>
            <label className="stack" style={{ gap: 4, flex: "1 1 200px" }}><span className="label">{d.clubEventStart} ({d.optional})</span>
              <input name="startTime" type="time" className="field" /></label>
          </div>
          <label className="stack" style={{ gap: 4 }}><span className="label">{d.clubEventPlace} ({d.optional})</span>
            <input name="place" className="field" maxLength={EVENT_LIMITS.place} /></label>
          <label className="stack" style={{ gap: 4 }}><span className="label">{d.clubEventNotes} ({d.optional})</span>
            <textarea name="notes" className="field" rows={2} maxLength={EVENT_LIMITS.notes} /></label>
          <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>{d.clubAddEvent}</button>
        </form>
      )}
    </section>
  );
}

/** Sponsors and members, live from the Signify ID class. Sponsors only: ID doesn't give students the roster. */
export function ClubMembers({ ok, members, d }: { ok: boolean; members: IdMember[]; d: Dict }) {
  const sponsors = members.filter((m) => m.role !== "student");
  const kids = members.filter((m) => m.role === "student");
  return (
    <section className="card stack" aria-labelledby="club-members" style={{ gap: 8 }}>
      <h2 id="club-members" className="label">{d.clubMembers}</h2>
      {!ok ? <div className="notice notice-bad" role="alert">{d.classesFailed}</div> : (
        <>
          <p style={{ margin: 0 }}><strong>{d.clubSponsors}:</strong> {sponsors.map((m) => m.display_name).join(", ") || "—"}</p>
          <p style={{ margin: 0 }}><strong>{d.clubMembersCount.replace("{n}", String(kids.length))}:</strong> {kids.map((m) => m.display_name).join(", ") || "—"}</p>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.clubMembersHint}</p>
        </>
      )}
    </section>
  );
}

/** A sponsor marks this Signify ID class as a club, or back as a class. Nothing is deleted either way. */
export function ClubSwitch({ courseId, club, d }: { courseId: string; club: boolean; d: Dict }) {
  return (
    <details>
      <summary className="label" style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>{club ? d.clubIsClub : d.clubMakeTitle}</summary>
      <form action={switchKind} className="stack" style={{ gap: 6, marginTop: 6 }}>
        <input type="hidden" name="courseId" value={courseId} />
        <input type="hidden" name="kind" value={club ? "class" : "club"} />
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{club ? d.clubBackHint : d.clubMakeHint}</p>
        <button className="btn" type="submit" style={{ alignSelf: "flex-start" }}>{club ? d.clubBack : d.clubMake}</button>
      </form>
    </details>
  );
}
