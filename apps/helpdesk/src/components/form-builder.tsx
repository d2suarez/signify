"use client";

import { useActionState, useState } from "react";
import { saveForm, type FormState } from "@/lib/actions";
import { FIELD_TYPES, type FormFieldDef } from "@/lib/forms";
import { CATEGORIES, USER_ROLES } from "@/lib/labels";
import { SubmitButton } from "./submit-button";

type BuilderField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  optionsText: string;
};

type InitialForm = {
  id: string;
  name: string;
  description: string;
  category: string;
  active: boolean;
  roles: string[];
  fields: FormFieldDef[];
};

function newField(): BuilderField {
  return { id: crypto.randomUUID(), label: "", type: "TEXT", required: false, optionsText: "" };
}

export function FormBuilder({ initial }: { initial: InitialForm | null }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? "OTHER");
  const [active, setActive] = useState(initial?.active ?? true);
  const [roles, setRoles] = useState<string[]>(initial?.roles ?? ["STAFF", "STUDENT"]);
  const [fields, setFields] = useState<BuilderField[]>(
    initial?.fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required,
      optionsText: f.options.join("\n"),
    })) ?? [newField()]
  );

  const action = saveForm.bind(null, initial?.id ?? null);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  const payload = JSON.stringify({
    name,
    description,
    category,
    active,
    roles,
    fields: fields.map(({ optionsText, ...f }) => ({
      ...f,
      options: optionsText.split("\n").map((s) => s.trim()).filter(Boolean),
    })),
  });

  function updateField(id: string, patch: Partial<BuilderField>) {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function moveField(index: number, delta: number) {
    setFields((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function toggleRole(role: string) {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="payload" value={payload} />

      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      <section className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="form-name">Form name</label>
            <input
              id="form-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="input"
              placeholder="e.g. Field Trip Request"
            />
          </div>
          <div>
            <label className="label" htmlFor="form-category">Tickets go to category</label>
            <select
              id="form-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input"
            >
              {Object.entries(CATEGORIES).map(([value, c]) => (
                <option key={value} value={value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="form-description">
            Description <span className="font-normal text-slate-400">(shown at the top of the form)</span>
          </label>
          <textarea
            id="form-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="input"
          />
        </div>

        <fieldset>
          <legend className="label">Who can use this form?</legend>
          <div className="flex flex-wrap gap-3">
            {Object.entries(USER_ROLES).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm font-medium shadow-sm has-checked:border-blue-600 has-checked:bg-blue-50"
              >
                <input
                  type="checkbox"
                  checked={roles.includes(value)}
                  onChange={() => toggleRole(value)}
                  className="accent-blue-600"
                />
                {label}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-400">Admins can always open any form.</p>
        </fieldset>

        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="accent-blue-600"
          />
          Published — visible on the home page
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Fields</h2>
        {fields.map((fieldDef, index) => (
          <div key={fieldDef.id} className="card space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <label className="label">Question / label</label>
                <input
                  value={fieldDef.label}
                  onChange={(e) => updateField(fieldDef.id, { label: e.target.value })}
                  className="input"
                  placeholder="e.g. Where is the trip going?"
                />
              </div>
              <div>
                <label className="label">Type</label>
                <select
                  value={fieldDef.type}
                  onChange={(e) => updateField(fieldDef.id, { type: e.target.value })}
                  className="input w-auto"
                >
                  {Object.entries(FIELD_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <label className="mb-2.5 flex cursor-pointer items-center gap-1.5 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={fieldDef.required}
                  onChange={(e) => updateField(fieldDef.id, { required: e.target.checked })}
                  className="accent-blue-600"
                />
                Required
              </label>
              <div className="mb-1 flex gap-1">
                <button
                  type="button"
                  onClick={() => moveField(index, -1)}
                  disabled={index === 0}
                  className="btn-secondary px-2.5 py-1.5 disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveField(index, 1)}
                  disabled={index === fields.length - 1}
                  className="btn-secondary px-2.5 py-1.5 disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setFields((prev) => prev.filter((f) => f.id !== fieldDef.id))}
                  className="btn-secondary px-2.5 py-1.5 text-red-600"
                  aria-label="Remove field"
                >
                  ✕
                </button>
              </div>
            </div>
            {fieldDef.type === "SELECT" && (
              <div>
                <label className="label">Dropdown options (one per line)</label>
                <textarea
                  value={fieldDef.optionsText}
                  onChange={(e) => updateField(fieldDef.id, { optionsText: e.target.value })}
                  rows={3}
                  className="input"
                  placeholder={"Option A\nOption B"}
                />
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFields((prev) => [...prev, newField()])}
          className="btn-secondary"
        >
          + Add field
        </button>
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…">Save form</SubmitButton>
        <a href="/dashboard/forms" className="text-sm font-medium text-slate-500 hover:underline">
          Cancel
        </a>
      </div>
    </form>
  );
}
