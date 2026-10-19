"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/actions";
import { SubmitButton } from "../submit-button";

type Initial = {
  title: string;
  description: string;
  color: string;
  status: string;
  visibility: string;
  startDate: string;
  dueDate: string;
};

const COLORS = [
  { value: "p2", shape: "square", label: "Blue" },
  { value: "p1", shape: "circle", label: "Red" },
  { value: "p4", shape: "arch", label: "Teal" },
  { value: "p3", shape: "triangle", label: "Yellow" },
];

const STATUSES = [
  { value: "PLANNING", label: "Planning" },
  { value: "ACTIVE", label: "Under way" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "DONE", label: "Done" },
];

export function ProjectForm({
  action,
  initial,
  submitLabel,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  initial?: Initial;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  return (
    <form action={formAction} className="space-y-5">
      {state.error && <p className="rounded-[var(--radius-md)] bg-red-50 px-4 py-3 text-sm text-red-800">{state.error}</p>}
      {state.message && <p className="rounded-[var(--radius-md)] bg-green-50 px-4 py-3 text-sm text-green-800">{state.message}</p>}

      <div>
        <label className="label" htmlFor="title">Name</label>
        <input id="title" name="title" required maxLength={120} defaultValue={initial?.title} className="input" placeholder="Spring science fair" />
      </div>
      <div>
        <label className="label" htmlFor="description">What it's for</label>
        <textarea id="description" name="description" rows={3} defaultValue={initial?.description} className="input" placeholder="What has to happen, and by when" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="startDate">Starts</label>
          <input id="startDate" name="startDate" type="date" defaultValue={initial?.startDate} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="dueDate">Finishes</label>
          <input id="dueDate" name="dueDate" type="date" defaultValue={initial?.dueDate} className="input" />
        </div>
      </div>

      <fieldset>
        <legend className="label">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <label key={c.value} className="chip cursor-pointer has-checked:ring-2 has-checked:ring-[var(--ink)]">
              <input type="radio" name="color" value={c.value} defaultChecked={(initial?.color ?? "p2") === c.value} className="sr-only" />
              <span aria-hidden className={`shape shape-${c.shape}`} style={{ color: `var(--${c.value})`, width: 12, height: 12 }} />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>

      {initial && (
        <div>
          <label className="label" htmlFor="status">Where it's at</label>
          <select id="status" name="status" defaultValue={initial.status} className="input sm:w-60">
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      )}

      <fieldset>
        <legend className="label">Who can see it</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="inset flex cursor-pointer gap-3 p-3 has-checked:bg-blue-50 has-checked:ring-2 has-checked:ring-[var(--p2)]">
            <input type="radio" name="visibility" value="MEMBERS" defaultChecked={(initial?.visibility ?? "MEMBERS") === "MEMBERS"} className="mt-1 accent-blue-600" />
            <span>
              <span className="block text-sm font-semibold">Only the people on it</span>
              <span className="block text-xs text-slate-500">Help desk admins can always see projects.</span>
            </span>
          </label>
          <label className="inset flex cursor-pointer gap-3 p-3 has-checked:bg-blue-50 has-checked:ring-2 has-checked:ring-[var(--p2)]">
            <input type="radio" name="visibility" value="SCHOOL" defaultChecked={initial?.visibility === "SCHOOL"} className="mt-1 accent-blue-600" />
            <span>
              <span className="block text-sm font-semibold">Everyone at school</span>
              <span className="block text-xs text-slate-500">Anyone can look. Only the people on it can change it.</span>
            </span>
          </label>
        </div>
      </fieldset>

      <SubmitButton>{submitLabel}</SubmitButton>
    </form>
  );
}
