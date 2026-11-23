"use client";

import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n";

type View = "hidden" | "list" | "thread";

/** What students see of a lesson. A Save button appears once it is changed. */
export function StudentViewSelect({ id, name, value, d, autoSubmit = false }: { id: string; name: string; value: View; d: Dict; autoSubmit?: boolean }) {
  const [v, setV] = useState<View>(value);
  return (
    <>
      <select id={id} name={name} className="field" style={{ width: "auto", flex: "0 1 320px" }} value={v} onChange={(e) => setV(e.target.value as View)}>
        <option value="hidden">{d.svHidden}</option>
        <option value="list">{d.svList}</option>
        <option value="thread">{d.svThread}</option>
      </select>
      {(!autoSubmit || v !== value) && <button className="btn btn-sm btn-primary" type="submit">{d.save}</button>}
    </>
  );
}

/** "Select all" for one unit's items in the organize form, and the count of what is chosen. */
export function SelectAll({ group, label }: { group: string; label: string }) {
  const [on, setOn] = useState(false);
  return (
    <label className="check" style={{ fontSize: 14 }}>
      <input type="checkbox" checked={on} onChange={(e) => {
        setOn(e.target.checked);
        document.querySelectorAll<HTMLInputElement>(`input[data-org-group="${group}"]`).forEach((c) => { c.checked = e.target.checked; });
        document.dispatchEvent(new Event("org-change"));
      }} />{" "}{label}
    </label>
  );
}

export function SelectedCount({ template }: { template: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const count = () => setN(document.querySelectorAll('input[name="item"][form="org"]:checked').length);
    count();
    document.addEventListener("change", count);
    document.addEventListener("org-change", count);
    return () => { document.removeEventListener("change", count); document.removeEventListener("org-change", count); };
  }, []);
  return <b aria-live="polite">{template.replace("{n}", String(n))}</b>;
}
