"use client";

import { useActionState, useState } from "react";
import { saveCategory, type FormState } from "@/lib/actions";
import type { FormFieldDef } from "@/lib/forms";
import { USER_ROLES } from "@/lib/labels";
import { FieldsEditor, fromBuilderFields, toBuilderFields, type BuilderField } from "./fields-editor";
import { SubmitButton } from "./submit-button";

type InitialCategory = {
  id: string;
  name: string;
  nameEs: string;
  hint: string;
  hintEs: string;
  shape: string;
  color: string;
  titlePrompt: string;
  askLocation: string;
  askDevice: string;
  roles: string[];
  active: boolean;
  fields: FormFieldDef[];
};

const SHAPE_NAMES: Record<string, string> = { square: "Square", circle: "Circle", arch: "Arch", triangle: "Triangle" };
const COLOR_NAMES: Record<string, string> = { p1: "Red", p2: "Blue", p3: "Yellow", p4: "Teal" };
const ASK_NAMES: Record<string, string> = { HIDDEN: "Don't ask", OPTIONAL: "Optional", REQUIRED: "Required" };

export function CategoryEditor({ initial }: { initial: InitialCategory | null }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [nameEs, setNameEs] = useState(initial?.nameEs ?? "");
  const [hint, setHint] = useState(initial?.hint ?? "");
  const [hintEs, setHintEs] = useState(initial?.hintEs ?? "");
  const [shape, setShape] = useState(initial?.shape ?? "triangle");
  const [color, setColor] = useState(initial?.color ?? "p3");
  const [titlePrompt, setTitlePrompt] = useState(initial?.titlePrompt ?? "");
  const [askLocation, setAskLocation] = useState(initial?.askLocation ?? "OPTIONAL");
  const [askDevice, setAskDevice] = useState(initial?.askDevice ?? "HIDDEN");
  const [roles, setRoles] = useState<string[]>(initial?.roles ?? ["ADMIN", "TECH", "STAFF", "STUDENT"]);
  const [active, setActive] = useState(initial?.active ?? true);
  const [fields, setFields] = useState<BuilderField[]>(initial ? toBuilderFields(initial.fields) : []);

  const action = saveCategory.bind(null, initial?.id ?? null);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  const payload = JSON.stringify({
    name, nameEs, hint, hintEs, shape, color, titlePrompt, askLocation, askDevice, roles, active,
    fields: fromBuilderFields(fields),
  });

  function toggleRole(role: string) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
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
            <label className="label" htmlFor="c-name">Name</label>
            <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} className="input" placeholder="e.g. Technology" />
          </div>
          <div>
            <label className="label" htmlFor="c-name-es">
              Name in Spanish <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="c-name-es" value={nameEs} onChange={(e) => setNameEs(e.target.value)} maxLength={60} className="input" placeholder="e.g. Tecnología" />
          </div>
          <div>
            <label className="label" htmlFor="c-hint">
              Hint <span className="font-normal text-slate-400">(under the name)</span>
            </label>
            <input id="c-hint" value={hint} onChange={(e) => setHint(e.target.value)} maxLength={200} className="input" placeholder="e.g. Chromebooks, Wi-Fi, projectors" />
          </div>
          <div>
            <label className="label" htmlFor="c-hint-es">
              Hint in Spanish <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input id="c-hint-es" value={hintEs} onChange={(e) => setHintEs(e.target.value)} maxLength={200} className="input" />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label" htmlFor="c-shape">Shape</label>
            <select id="c-shape" value={shape} onChange={(e) => setShape(e.target.value)} className="input w-auto">
              {Object.entries(SHAPE_NAMES).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-color">Colour</label>
            <select id="c-color" value={color} onChange={(e) => setColor(e.target.value)} className="input w-auto">
              {Object.entries(COLOR_NAMES).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <p className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden className={`shape shape-${shape} text-${color}`} />
            {name || "Preview"}
          </p>
        </div>

        <fieldset>
          <legend className="label">Who can pick this category?</legend>
          <div className="flex flex-wrap gap-3">
            {Object.entries(USER_ROLES).map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm font-medium shadow-sm has-checked:border-blue-600 has-checked:bg-blue-50"
              >
                <input type="checkbox" checked={roles.includes(value)} onChange={() => toggleRole(value)} className="accent-blue-600" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-blue-600" />
          Showing on the request form
        </label>
      </section>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="font-semibold">The form for this category</h2>
          <p className="text-sm text-slate-500">
            Everyone is asked for a short summary, details, urgency and photos. These change what else is asked.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="c-prompt">
            Example in the summary box <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input id="c-prompt" value={titlePrompt} onChange={(e) => setTitlePrompt(e.target.value)} maxLength={120} className="input" placeholder="e.g. Projector won't turn on" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="c-loc">Ask where it is</label>
            <select id="c-loc" value={askLocation} onChange={(e) => setAskLocation(e.target.value)} className="input">
              {Object.entries(ASK_NAMES).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">A dropdown of the places listed under Locations.</p>
          </div>
          <div>
            <label className="label" htmlFor="c-dev">Ask which device</label>
            <select id="c-dev" value={askDevice} onChange={(e) => setAskDevice(e.target.value)} className="input">
              {Object.entries(ASK_NAMES).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">e.g. &ldquo;Chromebook C-114&rdquo;.</p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Extra questions</h2>
          <p className="text-sm text-slate-500">Asked only when someone picks this category. Answers show on the ticket.</p>
        </div>
        <FieldsEditor
          fields={fields}
          setFields={setFields}
          addLabel="+ Add question"
          labelPlaceholder="e.g. Is water on the floor?"
        />
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…">Save category</SubmitButton>
        <a href="/dashboard/categories" className="text-sm font-medium text-slate-500 hover:underline">Cancel</a>
      </div>
    </form>
  );
}
