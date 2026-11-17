import type { Dict } from "@/lib/i18n";
import type { ShareRequest } from "@/lib/sections";
import { answerRequest } from "@/app/courses/[id]/section-actions";

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

/** Requests to copy from this person's classes, to say yes or no; or shares already given, to take back. */
export function ShareRequests({ list, granted, back, d }: { list: ShareRequest[]; granted?: boolean; back: string; d: Dict }) {
  return (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8 }}>
      {list.map((r) => (
        <li key={r.id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
          <div className="grow" style={{ minWidth: 200 }}>
            <strong>{r.requestedName || d.secAsker}</strong>: {r.sourceName} <span className="muted">· {r.sourceYear || d.secNoYear}</span>
            {r.forCourseName && <span className="muted"> · {fill(d.secWantsFor, { name: r.forCourseName })}</span>}
            {r.message && <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{r.message}</p>}
          </div>
          <form action={answerRequest} className="row" style={{ gap: 6 }}>
            <input type="hidden" name="requestId" value={r.id} />
            <input type="hidden" name="back" value={back} />
            {granted
              ? <button className="btn btn-sm" name="op" value="revoke">{d.secRevoke}</button>
              : <>
                  <button className="btn btn-sm btn-primary" name="op" value="approve">{d.secApprove}</button>
                  <button className="btn btn-sm" name="op" value="decline">{d.secDecline}</button>
                </>}
          </form>
        </li>
      ))}
    </ul>
  );
}
