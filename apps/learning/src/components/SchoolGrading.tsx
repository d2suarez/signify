"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Dict } from "@/lib/i18n";
import { SCALE_LIMITS, YEAR_GROUPS, gpaText, type SchoolScales } from "@/lib/grade-scale";
import { LATE_KINDS, LATE_LIMITS, WORK_KINDS, type LateKind, type LatePolicies, type TeacherChoice, type WorkKind } from "@/lib/late-policy";

type Status = { kind: "ok" | "bad"; text: string } | null;

/** Sends one setting; the server cleans it, checks the version and keeps the old one. */
async function put(key: "scales" | "late", value: unknown, baseVersion: number): Promise<{ ok: true; version: number } | { ok: false; error: string; problem?: string; band?: number }> {
  try {
    const res = await fetch("/api/school/grading", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value, baseVersion }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, version: out.setting.version };
    return { ok: false, error: out.error || "error", problem: out.problem, band: out.band };
  } catch {
    return { ok: false, error: "error" };
  }
}

// ---------- scales ----------

type RowText = { letter: string; min: string; gpa: string };
type BandText = { id: string; name: string; grades: string[]; rows: RowText[] };

const toText = (s: SchoolScales): BandText[] => s.bands.map((b) => ({
  id: b.id, name: b.name, grades: b.grades,
  rows: b.rows.map((r) => ({ letter: r.letter, min: String(r.min), gpa: gpaText(r.gpa) })),
}));

/**
 * The school's letter scales, one per grade band: name, the grade levels it
 * holds, and each letter's cut-off and GPA points.
 */
export function ScalesEditor({ initial, version: v0, canEdit, d }: { initial: SchoolScales; version: number; canEdit: boolean; d: Dict }) {
  const router = useRouter();
  const [bands, setBands] = useState<BandText[]>(toText(initial));
  const [version, setVersion] = useState(v0);
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);

  const change = (bi: number, fn: (b: BandText) => BandText) => { setBands((all) => all.map((b, i) => (i === bi ? fn(b) : b))); setStatus(null); };
  const setRow = (bi: number, ri: number, patch: Partial<RowText>) => change(bi, (b) => ({ ...b, rows: b.rows.map((r, i) => (i === ri ? { ...r, ...patch } : r)) }));

  const save = async () => {
    setSaving(true);
    const value = { bands: bands.map((b) => ({ id: b.id, name: b.name, grades: b.grades, rows: b.rows.map((r) => ({ letter: r.letter, min: r.min.trim() === "" ? NaN : Number(r.min), gpa: r.gpa })) })) };
    const r = await put("scales", value, version);
    setSaving(false);
    if (r.ok) { setVersion(r.version); setStatus({ kind: "ok", text: d.savedOk }); router.refresh(); return; }
    if (r.error === "stale") { setStatus({ kind: "bad", text: d.staleSetting }); return; }
    const words = r.problem ? (d as Record<string, string>)[`scaleErr_${r.problem}`] ?? d.saveError : d.saveError;
    setStatus({ kind: "bad", text: r.band !== undefined && bands[r.band] ? `${words} (${bands[r.band].name || `#${r.band + 1}`})` : words });
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {bands.map((b, bi) => {
        const used = new Set(bands.filter((_, j) => j !== bi).flatMap((x) => x.grades));
        return (
          <fieldset key={b.id || bi} className="scale-band" disabled={!canEdit}>
            <legend className="sr-only">{b.name}</legend>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="fieldset" style={{ margin: 0, flex: "1 1 220px" }}>
                <label htmlFor={`band-${bi}`}>{d.bandName}</label>
                <input id={`band-${bi}`} className="field" value={b.name} maxLength={SCALE_LIMITS.name}
                  onChange={(e) => change(bi, (x) => ({ ...x, name: e.target.value }))} />
              </div>
              {canEdit && bands.length > 1 && (
                <button type="button" className="btn btn-sm" onClick={() => { setBands((all) => all.filter((_, i) => i !== bi)); setStatus(null); }}>{d.removeBand}</button>
              )}
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: "10px 0 0" }}>
              <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.bandGrades}</legend>
              <div className="row" style={{ gap: 4 }}>
                {YEAR_GROUPS.map((g) => (
                  <label key={g} className="grade-pick" title={used.has(g) ? d.scaleErr_gradeTwice : undefined}>
                    <input type="checkbox" checked={b.grades.includes(g)} disabled={used.has(g)}
                      onChange={(e) => change(bi, (x) => ({ ...x, grades: e.target.checked ? [...x.grades, g] : x.grades.filter((y) => y !== g) }))} />
                    <span>{g}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <table className="scale-table">
              <thead>
                <tr><th scope="col">{d.letterCol}</th><th scope="col">{d.fromPercent}</th><th scope="col">{d.gpaPoints}</th>{canEdit && <th scope="col"><span className="sr-only">{d.removeLetter}</span></th>}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    <td><input className="field" aria-label={`${b.name}: ${d.letterCol} ${ri + 1}`} value={r.letter} maxLength={SCALE_LIMITS.letter} onChange={(e) => setRow(bi, ri, { letter: e.target.value })} /></td>
                    <td><input className="field" aria-label={`${b.name}: ${r.letter} ${d.fromPercent}`} inputMode="numeric" value={r.min} onChange={(e) => setRow(bi, ri, { min: e.target.value })} /></td>
                    <td><input className="field" aria-label={`${b.name}: ${r.letter} ${d.gpaPoints}`} inputMode="decimal" value={r.gpa} onChange={(e) => setRow(bi, ri, { gpa: e.target.value })} /></td>
                    {canEdit && (
                      <td><button type="button" className="btn btn-sm" aria-label={`${d.removeLetter}: ${r.letter}`} disabled={b.rows.length <= 2}
                        onClick={() => change(bi, (x) => ({ ...x, rows: x.rows.filter((_, i) => i !== ri) }))}>×</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && b.rows.length < SCALE_LIMITS.rows && (
              <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => change(bi, (x) => ({ ...x, rows: [...x.rows, { letter: "", min: "", gpa: "" }] }))}>{d.addLetter}</button>
            )}
          </fieldset>
        );
      })}
      {canEdit && (
        <div className="row">
          {bands.length < SCALE_LIMITS.bands && (
            <button type="button" className="btn" onClick={() => { setBands((all) => [...all, { id: "", name: d.newBandName, grades: [], rows: (toText(initial)[0]?.rows ?? []) }]); setStatus(null); }}>
              {d.addBand}
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{d.saveScales}</button>
        </div>
      )}
      {status && <p className={`notice ${status.kind === "bad" ? "notice-bad" : ""}`} role={status.kind === "bad" ? "alert" : "status"} style={{ margin: 0 }}>{status.text}</p>}
    </div>
  );
}

// ---------- late policies ----------

type RuleText = { id: string; name: string; kind: LateKind; percent: string; max: string; bands: string[]; categories: string; kinds: WorkKind[] };

/**
 * The school's late policies, in order (the first that fits an assignment is
 * used), and whether teachers may set their own.
 */
export function LateEditor({ initial, version: v0, bands, canEdit, d }: {
  initial: LatePolicies; version: number; bands: { id: string; name: string }[]; canEdit: boolean; d: Dict;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<RuleText[]>(initial.rules.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, percent: String(r.percent), max: String(r.max || 100), bands: r.bands, categories: r.categories.join(", "), kinds: r.kinds,
  })));
  const [teachers, setTeachers] = useState<TeacherChoice>(initial.teachers);
  const [limits, setLimits] = useState({ minPercent: String(initial.limits.minPercent), maxPercent: String(initial.limits.maxPercent), maxCap: String(initial.limits.maxCap) });
  const [version, setVersion] = useState(v0);
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);

  const change = (i: number, patch: Partial<RuleText>) => { setRules((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r))); setStatus(null); };
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  const save = async () => {
    setSaving(true);
    const value = {
      rules: rules.map((r) => ({ ...r, categories: r.categories.split(",").map((c) => c.trim()).filter(Boolean) })),
      teachers, limits,
    };
    const r = await put("late", value, version);
    setSaving(false);
    if (r.ok) { setVersion(r.version); setStatus({ kind: "ok", text: d.savedOk }); router.refresh(); return; }
    setStatus({ kind: "bad", text: r.error === "stale" ? d.staleSetting : d.saveError });
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {rules.length === 0 && <p className="empty" style={{ margin: 0 }}>{d.noLateRules}</p>}
      {rules.map((r, i) => (
        <fieldset key={r.id || i} className="scale-band" disabled={!canEdit}>
          <legend className="sr-only">{r.name || d[`lateKind_${r.kind}`]}</legend>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="fieldset" style={{ margin: 0, flex: "1 1 200px" }}>
              <label htmlFor={`rule-name-${i}`}>{d.lateRuleName}</label>
              <input id={`rule-name-${i}`} className="field" value={r.name} maxLength={LATE_LIMITS.name} onChange={(e) => change(i, { name: e.target.value })} />
            </div>
            <div className="fieldset" style={{ margin: 0 }}>
              <label htmlFor={`rule-kind-${i}`}>{d.latePenalty}</label>
              <select id={`rule-kind-${i}`} className="field" value={r.kind} onChange={(e) => change(i, { kind: e.target.value as LateKind })}>
                {LATE_KINDS.map((k) => <option key={k} value={k}>{d[`lateKind_${k}`]}</option>)}
              </select>
            </div>
            {r.kind !== "none" && (
              <div className="fieldset" style={{ margin: 0 }}>
                <label htmlFor={`rule-pct-${i}`}>{d.percentOff}</label>
                <input id={`rule-pct-${i}`} className="field" style={{ width: 110 }} inputMode="decimal" value={r.percent} onChange={(e) => change(i, { percent: e.target.value })} />
              </div>
            )}
            {r.kind === "perDay" && (
              <div className="fieldset" style={{ margin: 0 }}>
                <label htmlFor={`rule-max-${i}`}>{d.atMostPercent}</label>
                <input id={`rule-max-${i}`} className="field" style={{ width: 110 }} inputMode="decimal" value={r.max} onChange={(e) => change(i, { max: e.target.value })} />
              </div>
            )}
          </div>
          <p className="flabel" style={{ fontWeight: 700, fontSize: 14, margin: "10px 0 4px" }}>{d.appliesTo}</p>
          <div className="row" style={{ gap: 4 }}>
            {bands.map((b) => (
              <label key={b.id} className="grade-pick">
                <input type="checkbox" checked={r.bands.includes(b.id)} onChange={(e) => change(i, { bands: toggle(r.bands, b.id, e.target.checked) })} />
                <span>{b.name}</span>
              </label>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>{r.bands.length ? "" : d.allBands}</span>
          </div>
          <div className="row" style={{ gap: 4, marginTop: 4 }}>
            {WORK_KINDS.map((k) => (
              <label key={k} className="grade-pick">
                <input type="checkbox" checked={r.kinds.includes(k)} onChange={(e) => change(i, { kinds: toggle(r.kinds, k, e.target.checked) })} />
                <span>{d[`workKind_${k}`]}</span>
              </label>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>{d.allKindsNote}</span>
          </div>
          <div className="fieldset" style={{ marginTop: 8 }}>
            <label htmlFor={`rule-cats-${i}`}>{d.lateCategories}</label>
            <input id={`rule-cats-${i}`} className="field" value={r.categories} onChange={(e) => change(i, { categories: e.target.value })} />
          </div>
          {canEdit && (
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm" disabled={i === 0}
                onClick={() => { setRules((all) => { const n = [...all]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; }); setStatus(null); }}>↑ {d.moveUp}</button>
              <button type="button" className="btn btn-sm" onClick={() => { setRules((all) => all.filter((_, j) => j !== i)); setStatus(null); }}>{d.removeLateRule}</button>
            </div>
          )}
        </fieldset>
      ))}
      {canEdit && rules.length < LATE_LIMITS.rules && (
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }}
          onClick={() => { setRules((all) => [...all, { id: "", name: "", kind: "perDay", percent: "10", max: "50", bands: [], categories: "", kinds: [] }]); setStatus(null); }}>
          {d.addLateRule}
        </button>
      )}

      <fieldset className="scale-band" disabled={!canEdit}>
        <legend className="flabel" style={{ fontWeight: 700, fontSize: 14 }}>{d.teachersOwnLate}</legend>
        {(["no", "yes", "within"] as const).map((t) => (
          <label key={t} className="row" style={{ gap: 8, minHeight: 44 }}>
            <input type="radio" name="teachers-late" checked={teachers === t} onChange={() => { setTeachers(t); setStatus(null); }} /> {d[`teachersLate_${t}`]}
          </label>
        ))}
        {teachers === "within" && (
          <div className="row" style={{ alignItems: "flex-end" }}>
            {(["minPercent", "maxPercent", "maxCap"] as const).map((k) => (
              <div key={k} className="fieldset" style={{ margin: 0 }}>
                <label htmlFor={`lim-${k}`}>{k === "minPercent" ? d.limitMin : k === "maxPercent" ? d.limitMax : d.limitCap}</label>
                <input id={`lim-${k}`} className="field" style={{ width: 110 }} inputMode="decimal" value={limits[k]}
                  onChange={(e) => { setLimits((l) => ({ ...l, [k]: e.target.value })); setStatus(null); }} />
              </div>
            ))}
          </div>
        )}
      </fieldset>

      {canEdit && <button type="button" className="btn btn-primary" style={{ alignSelf: "flex-end" }} disabled={saving} onClick={save}>{d.saveLate}</button>}
      {status && <p className={`notice ${status.kind === "bad" ? "notice-bad" : ""}`} role={status.kind === "bad" ? "alert" : "status"} style={{ margin: 0 }}>{status.text}</p>}
    </div>
  );
}

/** "Put this version back": a new save of an old version. */
export function RestoreButton({ settingKey, versionId, baseVersion, d }: { settingKey: "scales" | "late"; versionId: string; baseVersion: number; d: Dict }) {
  const [bad, setBad] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={async () => {
        const res = await fetch("/api/school/grading", {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: settingKey, restore: versionId, baseVersion }),
        }).catch(() => null);
        if (res?.ok) location.reload(); else setBad(true);
      }}>{d.restoreVersion}</button>
      {bad && <span role="alert" className="muted" style={{ fontSize: 12 }}>{d.staleSetting}</span>}
    </>
  );
}
