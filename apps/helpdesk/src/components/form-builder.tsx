"use client";

import { useActionState, useState } from "react";
import { saveForm, type FormState } from "@/lib/actions";
import type { FormFieldDef } from "@/lib/forms";
import { FieldsEditor, fromBuilderFields, newField, toBuilderFields, type BuilderField } from "./fields-editor";
import { USER_ROLES } from "@/lib/labels";
import { SubmitButton } from "./submit-button";

type InitialForm = {
  id: string;
  name: string;
  description: string;
  category: string;
  active: boolean;
  roles: string[];
  fields: FormFieldDef[];
};

export function FormBuilder({
  initial,
  categories,
}: {
  initial: InitialForm | null;
  categories: { key: string; name: string }[];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? categories[categories.length - 1]?.key ?? "OTHER");
  const [active, setActive] = useState(initial?.active ?? true);
  const [roles, setRoles] = useState<string[]>(initial?.roles ?? ["STAFF", "STUDENT"]);
  const [fields, setFields] = useState<BuilderField[]>(
    initial ? toBuilderFields(initial.fields) : [newField()]
  );

  const action = saveForm.bind(null, initial?.id ?? null);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  const payload = JSON.stringify({
    name,
    description,
    category,
    active,
    roles,
    fields: fromBuilderFields(fields),
  });

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
              {categories.map((c) => (
                <option key={c.key} value={c.key}>{c.name}</option>
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
        <FieldsEditor fields={fields} setFields={setFields} />
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
