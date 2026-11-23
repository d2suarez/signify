"use client";

import { useMemo, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { Concern, ConcernLevel } from "@/lib/integrity";
import { isParts, type Rubric } from "@/lib/rubric";
import { locate } from "@/lib/review";

type Person = { id: string; name: string; body: string | null };
const LEVELS: ConcernLevel[] = ["high", "medium", "note"];

/**
 * Integrity concerns on the review screen (story 01, grade assistant): a
 * drawer listing the teacher's concerns (High / Medium / Note, with the
 * evidence), adding and changing them, and a side-by-side compare of two
 * students at the same section. Concerns never take points off: nothing
 * here touches a grade.
 */
export default function IntegrityDrawer({ assignmentId, rubric, students, currentId, concerns, onConcerns, d }: {
  assignmentId: string; rubric: Rubric | null; students: Person[]; currentId: string;
  concerns: Concern[]; onConcerns: (c: Concern[]) => void; d: Dict;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sections = isParts(rubric) ? rubric.sections : [];
  const nameOf = useMemo(() => new Map(students.map((s) => [s.id, s.name])), [students]);
  const levelWord = (l: ConcernLevel) => (l === "high" ? d.icHigh : l === "medium" ? d.icMedium : d.icNote);
  const secName = (id: string | null) => { const k = sections.findIndex((s) => s.id === id); return k < 0 ? "" : sections[k].title || `${d.prSection} ${k + 1}`; };

  // The form: a new concern (editing = null) or a change to one.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [level, setLevel] = useState<ConcernLevel>("medium");
  const [who, setWho] = useState<string[]>([]);
  const [section, setSection] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Compare two students at one section.
  const [cmp, setCmp] = useState<{ a: string; b: string; section: string } | null>(null);

  const open = () => { setEditing(undefined); setCmp(null); setError(""); dialog.current?.showModal(); };
  const startNew = () => { setEditing(null); setLevel("medium"); setWho([currentId]); setSection(""); setEvidence(""); setError(""); };
  const startEdit = (c: Concern) => { setEditing(c.id); setLevel(c.level); setWho(c.studentIds); setSection(c.sectionId ?? ""); setEvidence(c.evidence); setError(""); };

  const save = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/integrity${editing ? `?c=${editing}` : ""}`, {
        method: editing ? "PUT" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ level, studentIds: who, sectionId: section || null, evidence }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.error === "students" ? d.icNeedStudent : out.error === "evidence" ? d.icNeedEvidence : out.error === "roster" ? d.rosterFailed : d.saveError); return; }
      onConcerns(editing ? concerns.map((c) => (c.id === editing ? out.concern : c)) : [...concerns, out.concern]);
      setEditing(undefined);
    } finally { setBusy(false); }
  };
  const remove = async (c: Concern) => {
    if (!confirm(d.icDeleteConfirm)) return;
    const res = await fetch(`/api/assignments/${assignmentId}/integrity?c=${c.id}`, { method: "DELETE" });
    if (res.ok) onConcerns(concerns.filter((x) => x.id !== c.id));
  };

  const excerpt = (id: string, sectionId: string) => {
    const p = students.find((s) => s.id === id);
    if (!p?.body) return null;
    const span = sectionId ? locate(rubric, p.body).sections[sectionId] : undefined;
    return { text: span ? p.body.slice(span.start, span.end) : p.body, whole: !!sectionId && !span };
  };
  const mine = concerns.filter((c) => c.studentIds.includes(currentId)).length;

  return (
    <>
      <button type="button" className="btn btn-sm" aria-haspopup="dialog" onClick={open}>
        ⚑ {d.icTitle}{concerns.length ? ` (${concerns.length})` : ""}{mine ? ` · ${d.icThisStudent.replace("{n}", String(mine))}` : ""}
      </button>
      <dialog ref={dialog} className="dialog integrity" aria-labelledby="ic-title" aria-describedby="ic-hint"
        onClick={(e) => { if (e.target === dialog.current && editing === undefined) dialog.current?.close(); }}>
        <div className="dialog-in">
          <div className="row">
            <h2 id="ic-title" style={{ fontSize: 22, flex: 1 }}>{d.icTitle}</h2>
            <button type="button" className="btn btn-sm" onClick={() => dialog.current?.close()}>{d.close}</button>
          </div>
          <p id="ic-hint" className="muted" style={{ margin: 0, fontSize: 14 }}>{d.icHint}</p>

          {cmp ? (
            <section aria-labelledby="ic-cmp" className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <h3 id="ic-cmp" style={{ fontSize: 17, flex: 1 }}>{d.icCompare}</h3>
                <button type="button" className="btn btn-sm" onClick={() => setCmp(null)}>← {d.icBack}</button>
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                {(["a", "b"] as const).map((k) => (
                  <label key={k} className="part-field" style={{ minWidth: 160, flex: 1 }}>
                    <span>{k === "a" ? d.icFirst : d.icSecond}</span>
                    <select className="field" value={cmp[k]} onChange={(e) => setCmp({ ...cmp, [k]: e.target.value })}>
                      {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                ))}
                {sections.length > 0 && (
                  <label className="part-field" style={{ minWidth: 160, flex: 1 }}>
                    <span>{d.prSection}</span>
                    <select className="field" value={cmp.section} onChange={(e) => setCmp({ ...cmp, section: e.target.value })}>
                      <option value="">{d.icWholeWork}</option>
                      {sections.map((s, k) => <option key={s.id} value={s.id}>{s.title || `${d.prSection} ${k + 1}`}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <div className="compare">
                {[cmp.a, cmp.b].map((id, k) => {
                  const x = excerpt(id, cmp.section);
                  return (
                    <div key={k} className="compare-col">
                      <p className="label" style={{ margin: "0 0 4px" }}>{nameOf.get(id)}</p>
                      {x ? <>
                        {x.whole && <p className="muted" style={{ fontSize: 12, margin: "0 0 4px" }}>{d.icSectionNotFound}</p>}
                        <div className="work-text" style={{ marginTop: 0 }}>{x.text}</div>
                      </> : <p className="empty">{d.noWork}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : editing !== undefined ? (
            // Not a <form>: the drawer sits inside the grading desk's form.
            <div className="stack" style={{ gap: 10 }} role="group" aria-label={editing ? d.edit : d.icAdd}>
              <fieldset className="fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{d.icLevel}</legend>
                <div className="seg">
                  {LEVELS.map((l) => <button key={l} type="button" aria-pressed={level === l} onClick={() => setLevel(l)}>{levelWord(l)}</button>)}
                </div>
              </fieldset>
              <fieldset className="fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{d.icWho}</legend>
                <div className="ic-who">
                  {students.map((s) => (
                    <label key={s.id} className="check">
                      <input type="checkbox" checked={who.includes(s.id)} onChange={(e) => setWho(e.target.checked ? [...who, s.id] : who.filter((x) => x !== s.id))} />
                      {s.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              {sections.length > 0 && (
                <label className="part-field">
                  <span>{d.prSection}</span>
                  <select className="field" value={section} onChange={(e) => setSection(e.target.value)}>
                    <option value="">{d.icAnySection}</option>
                    {sections.map((s, k) => <option key={s.id} value={s.id}>{s.title || `${d.prSection} ${k + 1}`}</option>)}
                  </select>
                </label>
              )}
              <label className="part-field">
                <span>{d.icEvidence}</span>
                <textarea className="field" rows={4} maxLength={4000} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder={d.icEvidenceHint} />
              </label>
              {error && <p className="notice notice-bad" role="alert">{error}</p>}
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setEditing(undefined)}>{d.cancel}</button>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{d.save}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={startNew}>+ {d.icAdd}</button>
                {students.length > 1 && (
                  <button type="button" className="btn btn-sm" onClick={() => setCmp({ a: currentId, b: students.find((s) => s.id !== currentId)!.id, section: sections[0]?.id ?? "" })}>{d.icCompare}</button>
                )}
              </div>
              {concerns.length === 0 ? <p className="empty">{d.icNone}</p> : (
                <ul className="list ic-list">
                  {concerns.map((c) => (
                    <li key={c.id} className={`ic-item ic-${c.level}`}>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <span className={`chip ic-chip ic-${c.level}`}>{levelWord(c.level)}</span>
                        <b style={{ flex: 1 }}>{c.studentIds.map((id) => nameOf.get(id) ?? "?").join(", ")}</b>
                        {c.sectionId && <span className="muted" style={{ fontSize: 13 }}>{secName(c.sectionId)}</span>}
                      </div>
                      <p style={{ margin: "6px 0", whiteSpace: "pre-wrap", fontSize: 14 }}>{c.evidence}</p>
                      <div className="row" style={{ gap: 6 }}>
                        {c.studentIds.length >= 2 && (
                          <button type="button" className="btn btn-sm" onClick={() => setCmp({ a: c.studentIds[0], b: c.studentIds[1], section: c.sectionId ?? "" })}>{d.icCompare}</button>
                        )}
                        <button type="button" className="btn btn-sm" onClick={() => startEdit(c)}>{d.edit}</button>
                        <button type="button" className="btn btn-sm" onClick={() => remove(c)}>{d.delete}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
