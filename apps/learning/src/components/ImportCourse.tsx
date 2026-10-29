"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { Preview, ImportResult } from "@/lib/cc-import";

type Stage =
  | { at: "choose"; error?: string }
  | { at: "reading" }
  | { at: "preview"; preview: Preview }
  | { at: "importing"; preview: Preview }
  | { at: "done"; result: ImportResult };

const SHAPE = { lesson: "s-arch", assignment: "s-tri", quiz: "s-tri" } as const;

/**
 * Two steps: read the export and show what it would make (nothing written),
 * then import it all at once. The file stays in this page between the steps
 * and is sent again for the import, so the server keeps nothing in between.
 */
export default function ImportCourse({ courseId, courseName, maxBytes, d }: {
  courseId: string; courseName: string; maxBytes: number; d: Dict;
}) {
  const [stage, setStage] = useState<Stage>({ at: "choose" });
  const [file, setFile] = useState<File | null>(null);
  const [keepDates, setKeepDates] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const message = (code: string): string => {
    const key = `importErr_${code.replace(/-/g, "_")}` as keyof Dict;
    return d[key] ?? d.importErr_other;
  };

  const send = async (f: File, step: "preview" | "import") => {
    const q = new URLSearchParams({ step });
    if (step === "import") { q.set("keepDates", keepDates ? "1" : "0"); q.set("name", f.name); }
    const res = await fetch(`/api/courses/${courseId}/import?${q}`, {
      method: "POST", body: f, headers: { "content-type": "application/octet-stream" },
    });
    const json = await res.json().catch(() => ({ error: "other" }));
    if (!res.ok) throw new Error(String(json.error || "other"));
    return json;
  };

  const read = async (f: File) => {
    setFile(f);
    if (f.size > maxBytes) { setStage({ at: "choose", error: message("upload-too-large") }); return; }
    setStage({ at: "reading" });
    try {
      const { preview } = await send(f, "preview");
      setStage({ at: "preview", preview });
    } catch (e) {
      setStage({ at: "choose", error: message((e as Error).message) });
    }
  };

  const go = async (preview: Preview) => {
    if (!file) return;
    setStage({ at: "importing", preview });
    try {
      const { result } = await send(file, "import");
      setStage({ at: "done", result });
    } catch (e) {
      setStage({ at: "choose", error: message((e as Error).message) });
    }
  };

  if (stage.at === "done") {
    const s = stage.result.summary;
    return (
      <section className="card stack" style={{ gap: 10 }} aria-live="polite">
        <h2 style={{ fontSize: 22 }}>{d.importDone}</h2>
        <p style={{ margin: 0 }}>{s.units} {d.importUnits} · {s.lessons} {d.importLessons} · {s.assignments} {d.importAssignments} · {s.quizzesImported} {d.importQuizzesMade}</p>
        {s.discussionsImported > 0 && <p style={{ margin: 0 }}>{d.importDiscussionsNote.replace("{n}", String(s.discussionsImported))}</p>}
        <p className="muted" style={{ margin: 0 }}>{d.importDraftNote}</p>
        <Link className="btn btn-primary" style={{ alignSelf: "flex-start" }} href={`/courses/${courseId}`}>{d.importSeeCourse}</Link>
      </section>
    );
  }

  if (stage.at === "preview" || stage.at === "importing") {
    const p = stage.preview;
    const s = p.summary;
    const skippedBits = [
      s.quizzes && `${d.importQuizzes} (${s.quizzes})`,
      s.questionsSkipped && `${d.importQuestions} (${s.questionsSkipped})`,
      s.discussions && `${d.importDiscussions} (${s.discussions})`,
      s.tools && `${d.importTools} (${s.tools})`,
      s.files && `${d.importFiles} (${s.files})`,
      s.other && `${d.importOther} (${s.other})`,
    ].filter(Boolean);
    const busy = stage.at === "importing";
    const nothing = s.lessons + s.assignments + s.units + s.quizzesImported === 0;
    return (
      <div className="stack">
        <section className="card stack" style={{ gap: 8 }} aria-labelledby="imp-sum">
          <h2 id="imp-sum" style={{ fontSize: 22 }}>{p.courseTitle || file?.name}</h2>
          <p style={{ margin: 0, fontSize: 18 }}>
            <b>{s.units}</b> {d.importUnits} · <b>{s.lessons}</b> {d.importLessons} · <b>{s.assignments}</b> {d.importAssignments}
            {" · "}<b>{s.quizzesImported}</b> {d.importQuizzesMade} <span className="muted">({s.questions} {d.importQuestionsMade})</span>
          </p>
          {s.discussionsImported > 0 && <p style={{ margin: 0 }}>{d.importDiscussionsNote.replace("{n}", String(s.discussionsImported))}</p>}
          {skippedBits.length > 0 && <p style={{ margin: 0 }}>{d.importSkipped}: {skippedBits.join(", ")}.</p>}
          {s.quizzes + s.questionsSkipped > 0 && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.importKeptNote}</p>}
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.importIntoNote} <b>{courseName}</b>. {d.importDraftNote}</p>
          {p.importedBefore.length > 0 && (
            <p className="notice notice-bad" style={{ margin: 0 }}>
              {d.importAgainWarn} {new Date(p.importedBefore[0].at).toLocaleString()}.
            </p>
          )}
          {s.datedAssignments > 0 && (
            <label className="check" style={{ fontSize: 15 }}>
              <input type="checkbox" checked={keepDates} onChange={(e) => setKeepDates(e.target.checked)} disabled={busy} />{" "}
              {d.importKeepDates} ({s.datedAssignments})
            </label>
          )}
          {nothing && <p className="notice notice-bad" style={{ margin: 0 }}>{d.importErr_empty}</p>}
          <div className="row">
            <button className="btn btn-primary" onClick={() => go(p)} disabled={busy || nothing}>{busy ? d.importWorking : d.importGo}</button>
            <button className="btn" onClick={() => { setStage({ at: "choose" }); setFile(null); }} disabled={busy}>{d.cancel}</button>
          </div>
        </section>

        <section className="card" aria-labelledby="imp-outline">
          <h2 id="imp-outline" className="label">{d.importOutline}</h2>
          {p.outline.map((u, i) => (
            <div key={i} style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 17, margin: "0 0 4px" }}>
                <span className="shape s-square" style={{ marginRight: 8 }} />{u.title ?? d.noUnit}
              </h3>
              {u.items.length === 0 ? <p className="muted" style={{ margin: "0 0 0 26px", fontSize: 14 }}>{d.importEmptyUnit}</p> : (
                <ul style={{ margin: 0, paddingLeft: 26, listStyle: "none" }}>
                  {u.items.map((it, j) => (
                    <li key={j} style={{ padding: "3px 0" }}>
                      <span className={`shape ${SHAPE[it.kind]}`} style={{ marginRight: 8 }} />
                      <span className="sr-only">{it.kind === "lesson" ? d.lessonWord : it.kind === "quiz" ? d.kindQuiz : d.assignment}: </span>
                      {it.title}
                      {it.kind === "quiz" && <span className="muted" style={{ fontSize: 13 }}> · {d.kindQuiz} · {it.questions} {d.importQuestionsMade}</span>}
                      {it.discussion && <span className="muted" style={{ fontSize: 13 }}> · {d.importFromDiscussion}</span>}
                      {it.dueOn && <span className="muted" style={{ fontSize: 13 }}> · {d.due} {it.dueOn}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>

        {(p.skipped.length > 0 || p.missingFiles.length > 0) && (
          <section className="card" aria-labelledby="imp-left">
            <h2 id="imp-left" className="label">{d.importNotImported}</h2>
            {p.skipped.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {p.skipped.map((x, i) => (
                  <li key={i}>{x.title} <span className="muted" style={{ fontSize: 13 }}>· {d[`importKind_${x.kind}` as keyof Dict]}{x.unit ? ` · ${x.unit}` : ""}</span></li>
                ))}
              </ul>
            )}
            {p.missingFiles.length > 0 && (
              <>
                <p style={{ margin: "12px 0 4px" }}>{d.importMissingFiles}</p>
                <ul style={{ margin: 0, paddingLeft: 20, overflowWrap: "anywhere" }}>
                  {p.missingFiles.map((f) => <li key={f} style={{ fontSize: 14 }}>{f}</li>)}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    );
  }

  return (
    <section className="card stack" style={{ gap: 10 }}>
      <p style={{ margin: 0 }}>{d.importIntro}</p>
      <ol style={{ margin: 0, paddingLeft: 22, fontSize: 15 }}>
        <li>{d.importStep1}</li>
        <li>{d.importStep2}</li>
        <li>{d.importStep3}</li>
      </ol>
      <div className="fieldset">
        <label htmlFor="imp-file">{d.importChoose}</label>
        <input id="imp-file" ref={input} type="file" accept=".imscc,.zip,application/zip" className="field" style={{ minHeight: 44 }}
          disabled={stage.at === "reading"}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); }} />
      </div>
      {stage.at === "reading" && <p aria-live="polite" style={{ margin: 0 }}>{d.importReading}</p>}
      {stage.at === "choose" && stage.error && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>{stage.error}</p>}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.importPrivacy}</p>
    </section>
  );
}
