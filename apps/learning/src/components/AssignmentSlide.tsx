"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssignmentBlock } from "@/lib/blocks";
import type { Dict, Lang } from "@/lib/i18n";
import type { PostDoc } from "@/lib/post-doc";
import type { Submission } from "@/lib/assignments";
import type { StudentQuizView } from "@/lib/quiz-store";
import Instructions from "./Instructions";
import QuizTaker from "./QuizTaker";
import SubmissionEditor from "./SubmissionEditor";
import GroupWorkEditor from "./GroupWorkEditor";
import type { GroupState } from "@/lib/group-work";
import { When } from "./When";

/*
 * An assignment or quiz on a slide (story 01, D3/D10). The teacher's screen
 * shows whether it is published and, while presenting, a Publish button that
 * saves it published through the assignment's own route (the same save as
 * its page). Students' screens show their own work on it once it is
 * published: the writing box, the quiz, or a paper assignment's details.
 */

type TeacherView = { role: "teacher"; id: string; title: string; kind: string; points: number; dueAt: string | null; published: boolean; version: number };
type StudentView = {
  role: "student"; id: string; title: string; kind: string; points: number; dueAt: string | null;
  instructions: string; instructionsDoc: PostDoc | null; quiz: StudentQuizView | null; submission: Submission | null; locked: boolean; toolLinkId: string | null;
  /** Stopped accepting work (migration 044). */
  closesAt?: string | null; closed?: boolean;
  /** A group assignment: the student's group and its shared text (null when they work alone). */
  group?: GroupState | null; me?: string;
};
type Loaded<T> = { at: string; view: T | null; missing: boolean };

function kindWord(kind: string, d: Dict): string {
  return kind === "quiz" ? d.quizWord : d.pcKindAssignment;
}

function useAssignment<T>(id: string, stamp: number): [Loaded<T> | null, () => void] {
  const [got, setGot] = useState<Loaded<T> | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!id) return;
    let gone = false;
    fetch(`/api/assignments/${id}/live`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, body: r.ok ? await r.json() : null }))
      .then(({ ok, body }) => { if (!gone) setGot({ at: id, view: ok ? body : null, missing: !ok }); })
      .catch(() => { if (!gone) setGot({ at: id, view: null, missing: true }); });
    return () => { gone = true; };
  }, [id, stamp, n]);
  return [got && got.at === id ? got : null, useCallback(() => setN((x) => x + 1), [])];
}

export function TeacherAssignmentStage({ block, d, L = "en", onPublished }: {
  block: AssignmentBlock; d: Dict; L?: Lang;
  /** Present while presenting: shows Publish, and tells the class once it's done. */
  onPublished?: () => void;
}) {
  const [got, reload] = useAssignment<TeacherView>(block.assignmentId, 0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const a = got?.view ?? null;
  const title = a?.title || block.title || d.blockAssignment;

  const publish = async () => {
    if (!a) return;
    setBusy(true); setFailed(false);
    try {
      let version = a.version;
      for (let tries = 0; tries < 2; tries++) {
        const r = await fetch(`/api/assignments/${a.id}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseVersion: version, published: true }),
        });
        if (r.ok) { onPublished?.(); reload(); return; }
        // Someone saved it meanwhile (its page in another tab): publish that version.
        if (r.status === 409) { version = Number((await r.json()).assignment?.version); continue; }
        break;
      }
      setFailed(true);
    } catch { setFailed(true); } finally { setBusy(false); }
  };

  return (
    <div className="stage" style={{ background: "var(--p4)" }}>
      <p className="label" style={{ margin: 0, color: "inherit" }}><span className="shape s-tri" aria-hidden="true" style={{ marginRight: 8 }} />{a ? kindWord(a.kind, d) : d.blockAssignment}</p>
      <h1>{title}</h1>
      {!block.assignmentId ? <p className="body">{d.asgSlidePick}</p>
        : !got ? <p className="body muted">{d.asgSlideLoading}</p>
        : !a ? <p className="body">{d.asgSlideGone}</p>
        : (
          <>
            <p className="body" role="status">
              {a.published ? d.asgSlidePublished : d.asgSlideDraft}
              {a.dueAt && <> · {d.due} <When iso={a.dueAt} lang={L} /></>}
            </p>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {!a.published && onPublished && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={publish}>{busy ? d.asgSlidePublishing : d.asgSlidePublish}</button>
              )}
              <a className="btn" href={`/assignments/${a.id}`} target="_blank" rel="noopener">{d.asgSlideOpenPage} ↗</a>
            </div>
            {failed && <p className="notice" role="alert" style={{ margin: 0 }}>{d.asgSlideFailed}</p>}
          </>
        )}
    </div>
  );
}

export function StudentAssignmentStage({ block, d, L, stamp }: { block: AssignmentBlock; d: Dict; L: Lang; stamp: number }) {
  const [got] = useAssignment<StudentView>(block.assignmentId, stamp);
  const a = got?.view ?? null;
  if (!block.assignmentId || (got && !a)) {
    return (
      <div className="stage" style={{ background: "var(--p4)" }}>
        <p className="label" style={{ margin: 0, color: "inherit" }}><span className="shape s-tri" aria-hidden="true" style={{ marginRight: 8 }} />{d.blockAssignment}</p>
        <p className="body">{d.asgSlideWaiting}</p>
      </div>
    );
  }
  if (!a) return <p className="muted" style={{ padding: 20 }}>{d.asgSlideLoading}</p>;
  return (
    <div className="stack" style={{ gap: 14, padding: 8, textAlign: "left" }}>
      <div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {kindWord(a.kind, d)} · {a.dueAt ? <>{d.due} <When iso={a.dueAt} lang={L} /></> : d.noDue} · {a.points} {d.pts}
        </p>
        <h2 style={{ fontSize: 26, margin: "4px 0 0" }}>{a.title}</h2>
      </div>
      {a.closed && a.closesAt && <p className="notice" role="status" style={{ margin: 0 }}><b>{d.lockClosedAt}</b> <When iso={a.closesAt} lang={L} /> {d.lockStudentClosed}</p>}
      {a.instructions && <Instructions text={a.instructions} doc={a.instructionsDoc} d={d} L={L} />}
      {/* Keyed by assignment: moving to another slide starts fresh; publishing another never resets this one. */}
      {a.quiz
        ? <QuizTaker key={a.id} assignmentId={a.id} initial={a.quiz} points={a.points} d={d} closed={!!a.closed} />
        : a.kind === "online" && a.group
        ? <GroupWorkEditor key={a.id} assignmentId={a.id} initial={a.group} myId={a.me ?? ""} locked={a.locked} d={d} />
        : a.kind === "online"
        ? <SubmissionEditor key={a.id} assignmentId={a.id} initial={a.submission} locked={a.locked} d={d} />
        : a.toolLinkId
        ? <div className="stack" style={{ gap: 8 }}><p style={{ margin: 0 }}>{d.toolStudentHint}</p>
            <div><a className="btn btn-primary" href={`/lti/tool/launch?link=${a.toolLinkId}&target=window`} target="_blank" rel="noopener">{d.toolOpen} ↗</a></div></div>
        : <p className="notice" style={{ margin: 0 }}>{d.paperAssignment}</p>}
      <div><a className="btn btn-sm" href={`/assignments/${a.id}`} target="_blank" rel="noopener">{d.asgSlideOpenPage} ↗</a></div>
    </div>
  );
}
