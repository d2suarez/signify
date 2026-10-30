"use client";

import { useState } from "react";
import type { Dict } from "@/lib/i18n";
import StandardsPicker, { type StandardOption } from "./StandardsPicker";

/**
 * Which standards a lesson addresses, saved on each change (filing, like the
 * lesson's unit: it makes no new lesson version).
 */
export default function LessonStandards({ lessonId, courseId, options, initial, d }: {
  lessonId: string; courseId: string; options: StandardOption[]; initial: string[]; d: Dict;
}) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<"" | "saving" | "saved" | "error">("");
  const change = async (ids: string[]) => {
    setValue(ids);
    setStatus("saving");
    try {
      const res = await fetch(`/api/lessons/${lessonId}/standards`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ standards: ids }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setValue((await res.json()).standards);
      setStatus("saved");
    } catch { setStatus("error"); }
  };
  return (
    <section style={{ marginTop: 24 }}>
      <StandardsPicker options={options} value={value} onChange={change} addHref={`/standards?course=${courseId}`}
        legend={d.lessonStandards} hint={d.lessonStandardsHint} d={d} />
      <p className="muted" role="status" style={{ fontSize: 13, margin: "6px 0 0" }}>
        {status === "saving" ? d.saving : status === "saved" ? d.saved : status === "error" ? d.saveFailedShort : ""}
      </p>
    </section>
  );
}
