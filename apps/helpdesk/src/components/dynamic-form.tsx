"use client";

import { useActionState } from "react";
import { submitCustomTicket, type FormState } from "@/lib/actions";
import type { FormFieldDef } from "@/lib/forms";
import { SubmitButton } from "./submit-button";

export function DynamicForm({ formId, fields }: { formId: string; fields: FormFieldDef[] }) {
  const action = submitCustomTicket.bind(null, formId);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-5">
      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      {fields.map((field) => {
        const name = `f_${field.id}`;
        const optional = !field.required && field.type !== "CHECKBOX";
        return (
          <div key={field.id}>
            {field.type === "CHECKBOX" ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" name={name} className="size-4 accent-blue-600" />
                {field.label}
              </label>
            ) : (
              <>
                <label className="label" htmlFor={name}>
                  {field.label}
                  {optional && <span className="ml-1 font-normal text-slate-400">(optional)</span>}
                </label>
                {field.type === "TEXTAREA" ? (
                  <textarea id={name} name={name} required={field.required} rows={4} className="input" />
                ) : field.type === "SELECT" ? (
                  <select id={name} name={name} required={field.required} defaultValue="" className="input">
                    <option value="" disabled={field.required}>
                      Choose…
                    </option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={name}
                    name={name}
                    required={field.required}
                    type={field.type === "DATE" ? "date" : "text"}
                    className="input"
                  />
                )}
              </>
            )}
          </div>
        );
      })}

      <div>
        <label className="label" htmlFor="photos">
          Photos or files <span className="font-normal text-slate-400">(optional, up to 4)</span>
        </label>
        <input
          id="photos"
          name="photos"
          type="file"
          accept="image/*,.pdf"
          multiple
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        />
      </div>

      <SubmitButton className="btn-primary w-full py-3 text-base" pendingText="Submitting…">
        Submit
      </SubmitButton>
    </form>
  );
}
