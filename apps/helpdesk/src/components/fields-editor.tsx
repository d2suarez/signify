"use client";

import type { Dispatch, SetStateAction } from "react";
import { FIELD_TYPES, type FormFieldDef } from "@/lib/forms";

/** A question while it is being edited: dropdown options are one text box. */
export type BuilderField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  optionsText: string;
};

export function newField(): BuilderField {
  return { id: crypto.randomUUID(), label: "", type: "TEXT", required: false, optionsText: "" };
}

export function toBuilderFields(fields: FormFieldDef[]): BuilderField[] {
  return fields.map((f) => ({
    id: f.id,
    label: f.label,
    type: f.type,
    required: f.required,
    optionsText: f.options.join("\n"),
  }));
}

export function fromBuilderFields(fields: BuilderField[]) {
  return fields.map(({ optionsText, ...f }) => ({
    ...f,
    options: optionsText.split("\n").map((s) => s.trim()).filter(Boolean),
  }));
}

/** The list of questions with add / move / remove. Shared by forms and categories. */
export function FieldsEditor({
  fields,
  setFields,
  addLabel = "+ Add field",
  labelPlaceholder = "e.g. Where is the trip going?",
}: {
  fields: BuilderField[];
  setFields: Dispatch<SetStateAction<BuilderField[]>>;
  addLabel?: string;
  labelPlaceholder?: string;
}) {
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

  return (
    <>
      {fields.map((fieldDef, index) => (
        <div key={fieldDef.id} className="card space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              <label className="label" htmlFor={`q-${fieldDef.id}`}>Question / label</label>
              <input
                id={`q-${fieldDef.id}`}
                value={fieldDef.label}
                onChange={(e) => updateField(fieldDef.id, { label: e.target.value })}
                className="input"
                placeholder={labelPlaceholder}
              />
            </div>
            <div>
              <label className="label" htmlFor={`t-${fieldDef.id}`}>Type</label>
              <select
                id={`t-${fieldDef.id}`}
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
              <label className="label" htmlFor={`o-${fieldDef.id}`}>Dropdown options (one per line)</label>
              <textarea
                id={`o-${fieldDef.id}`}
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
        {addLabel}
      </button>
    </>
  );
}
