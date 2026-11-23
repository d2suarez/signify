"use client";

import { useState } from "react";
import type { Dict } from "@/lib/i18n";

export type TeacherGroup = {
  id: string; name: string;
  members: { id: string; name: string; handedIn: boolean }[];
  submitter: string | null; submittedAt: string | null;
};

/**
 * The teacher's view of a group assignment's groups (story 01, A10): who is
 * in each, who has handed in, and, when one member hands in for the group,
 * who that is (set here by the teacher, or as the group chose).
 */
export default function GroupHandIn({ assignmentId, groups: initial, mode, submitterBy, paper = false, d }: {
  assignmentId: string; groups: TeacherGroup[]; mode: "each" | "one"; submitterBy: "group" | "teacher";
  /** Paper / in class: nothing is handed in here, the groups are for grading. */
  paper?: boolean; d: Dict;
}) {
  const [groups, setGroups] = useState(initial);
  const [error, setError] = useState("");

  async function choose(groupId: string, studentId: string) {
    setError("");
    const res = await fetch(`/api/assignments/${assignmentId}/group-work`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-submitter", groupId, studentId: studentId || null }),
    });
    if (!res.ok) { setError(d.gaSetFailed); return; }
    setGroups((all) => all.map((g) => (g.id === groupId ? { ...g, submitter: studentId || null } : g)));
  }

  return (
    <section className="card stack" style={{ marginTop: 24, gap: 10 }} aria-labelledby="ga-title">
      <h2 id="ga-title" className="label"><span className="shape s-square" style={{ marginRight: 8 }} />{d.gaGroupsHere}</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {paper ? d.gaPaperHint : mode === "one" ? (submitterBy === "teacher" ? d.gaOneTeacherHint : d.gaOneGroupHint) : d.gaEachHint}
      </p>
      {error && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      <ul className="group-grid">
        {groups.map((g) => (
          <li key={g.id} className="group-card">
            <p className="group-name">
              {g.name}
              {g.submittedAt && <span className="chip chip-done">{d.handedIn}</span>}
            </p>
            <ul className="group-members">
              {g.members.map((m) => (
                <li key={m.id}>
                  {m.name}
                  {mode === "each" && m.handedIn && <span className="chip chip-done" style={{ marginLeft: 6 }}>{d.handedIn}</span>}
                  {mode === "one" && g.submitter === m.id && <span className="chip" style={{ marginLeft: 6 }}>{d.gaHandsIn}</span>}
                </li>
              ))}
            </ul>
            {mode === "one" && !g.submittedAt && (
              <div className="fieldset">
                <label htmlFor={`ga-${g.id}`} style={{ fontSize: 13 }}>{d.gaWhoHandsIn}</label>
                <select id={`ga-${g.id}`} className="field" value={g.submitter ?? ""} onChange={(e) => choose(g.id, e.target.value)}>
                  <option value="">{submitterBy === "group" ? d.gaGroupChooses : d.gaNobodyYet}</option>
                  {g.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
