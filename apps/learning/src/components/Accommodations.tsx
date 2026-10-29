"use client";

import { useState } from "react";
import type { Dict } from "@/lib/i18n";

type Row = { id: string; name: string; timeFactor: number; extraAttempts: number };
const FACTORS = [1, 1.25, 1.5, 2, 3];

/** Each student's quiz accommodations in this course: extra time and extra attempts, saved as they're chosen. */
export default function Accommodations({ courseId, students, d }: { courseId: string; students: Row[]; d: Dict }) {
  const [rows, setRows] = useState(students);
  const [state, setState] = useState<Record<string, "saving" | "saved" | "error">>({});
  const save = async (r: Row) => {
    setRows((all) => all.map((x) => (x.id === r.id ? r : x)));
    setState((s) => ({ ...s, [r.id]: "saving" }));
    try {
      const res = await fetch(`/api/courses/${courseId}/accommodations`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ studentId: r.id, timeFactor: r.timeFactor, extraAttempts: r.extraAttempts }),
      });
      setState((s) => ({ ...s, [r.id]: res.ok ? "saved" : "error" }));
    } catch {
      setState((s) => ({ ...s, [r.id]: "error" }));
    }
  };
  if (!rows.length) return <p className="empty">{d.noStudents}</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="plain-table">
        <thead><tr><th scope="col">{d.student}</th><th scope="col">{d.quizExtraTime}</th><th scope="col">{d.quizExtraAttempts}</th><th scope="col"><span className="sr-only">{d.saved}</span></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row" style={{ fontWeight: 600 }}>{r.name}</th>
              <td>
                <select className="field" style={{ width: "auto" }} aria-label={`${d.quizExtraTime}: ${r.name}`} value={r.timeFactor}
                  onChange={(e) => save({ ...r, timeFactor: Number(e.target.value) })}>
                  {[...new Set([...FACTORS, r.timeFactor])].sort((a, b) => a - b).map((f) => (
                    <option key={f} value={f}>{f === 1 ? d.quizNone : `× ${f}`}</option>
                  ))}
                </select>
              </td>
              <td>
                <select className="field" style={{ width: "auto" }} aria-label={`${d.quizExtraAttempts}: ${r.name}`} value={r.extraAttempts}
                  onChange={(e) => save({ ...r, extraAttempts: Number(e.target.value) })}>
                  {Array.from({ length: 11 }, (_, k) => <option key={k} value={k}>{k === 0 ? d.quizNone : `+ ${k}`}</option>)}
                </select>
              </td>
              <td role="status" aria-live="polite" style={{ fontSize: 13 }}>
                {state[r.id] === "saving" ? d.saving : state[r.id] === "saved" ? d.saved : state[r.id] === "error" ? d.saveError : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
