"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Dict } from "@/lib/i18n";
import { STUDENT_SAFE, WIDGET_KINDS, normalizeSchoolWidgets, type SchoolWidgets, type WidgetKind } from "@/lib/widgets";
import { KindList } from "./rail/KindList";

/**
 * The school's Desk tools: where each kind of person starts, which tools
 * students may have, and whether teachers choose for their classes. Saved
 * like the grading settings (version-checked; the old value is kept).
 */
export function SchoolWidgetsEditor({ initial, version: v0, canEdit, d }: { initial: SchoolWidgets; version: number; canEdit: boolean; d: Dict }) {
  const router = useRouter();
  const [v, setV] = useState<SchoolWidgets>(initial);
  const [version, setVersion] = useState(v0);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // Every change is cleaned the way the server will clean it (students' lists stay inside what students may have).
  const change = (patch: Partial<SchoolWidgets>) => { setV((cur) => normalizeSchoolWidgets({ ...cur, ...patch })); setStatus(null); };

  const save = async () => {
    setSaving(true);
    const res = await fetch("/api/school/widgets", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: v, baseVersion: version }),
    }).catch(() => null);
    setSaving(false);
    const out = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok) { setVersion(out.setting.version); setV(out.setting.value); setStatus({ ok: true, text: d.wgSchoolSaved }); router.refresh(); return; }
    setStatus({ ok: false, text: res?.status === 409 ? d.staleSetting : d.wgSaveFailed });
  };

  const lists: { key: "staffHome" | "staffClass" | "studentHome" | "studentClass"; label: string; candidates: readonly WidgetKind[] }[] = [
    { key: "staffHome", label: d.wgSchoolStaffHome, candidates: WIDGET_KINDS },
    { key: "staffClass", label: d.wgSchoolStaffClass, candidates: WIDGET_KINDS },
    { key: "studentHome", label: d.wgSchoolStudentHome, candidates: v.studentAllowed },
    { key: "studentClass", label: d.wgSchoolStudentClass, candidates: v.studentAllowed },
  ];

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="wg-policy">
        <h2 className="label" id="wg-policy">{d.wgSchoolPolicyTitle}</h2>
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }} disabled={!canEdit}>
          <legend className="todo-head" style={{ marginBottom: 6 }}>{d.wgSchoolAllowed}</legend>
          {STUDENT_SAFE.map((k) => (
            <label key={k} className="row wg-check">
              <input type="checkbox" checked={v.studentAllowed.includes(k)}
                onChange={(e) => change({ studentAllowed: e.target.checked ? [...v.studentAllowed, k] : v.studentAllowed.filter((x) => x !== k) })} />
              {d[`wg_${k}`]}
            </label>
          ))}
          <p className="muted wg-small" style={{ margin: 0 }}>{d.wgSchoolAllowedHint}</p>
        </fieldset>
        <label className="row wg-check">
          <input type="checkbox" checked={v.teachersChoose} disabled={!canEdit} onChange={(e) => change({ teachersChoose: e.target.checked })} />
          {d.wgSchoolTeachers}
        </label>
      </section>

      <section className="card stack" aria-labelledby="wg-defaults">
        <h2 className="label" id="wg-defaults">{d.wgSchoolDefaultsTitle}</h2>
        <div className="wg-school-lists">
          {lists.map((l) => (
            <div key={l.key} className="card wg-school-list">
              <KindList kinds={v[l.key]} candidates={l.candidates} onChange={(k) => change({ [l.key]: k })} d={d} label={l.label}
                markStaffOnly={l.key.startsWith("staff")} disabled={!canEdit} />
            </div>
          ))}
        </div>
      </section>

      {canEdit && (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? d.saving : d.save}</button>
          <span role="status" className={status && !status.ok ? "notice notice-bad" : "muted"}>{status?.text ?? ""}</span>
        </div>
      )}
    </div>
  );
}

export function RestoreWidgets({ versionId, baseVersion, d }: { versionId: string; baseVersion: number; d: Dict }) {
  const [bad, setBad] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" style={{ minHeight: 44 }} onClick={async () => {
        const res = await fetch("/api/school/widgets", {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ restore: versionId, baseVersion }),
        }).catch(() => null);
        if (res?.ok) location.reload(); else setBad(true);
      }}>{d.restoreVersion}</button>
      {bad && <span role="alert" className="muted" style={{ fontSize: 12 }}>{d.staleSetting}</span>}
    </>
  );
}
