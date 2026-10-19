"use client";

import { useActionState } from "react";
import { saveArticle, type FormState } from "@/lib/actions";
import { CATEGORIES, USER_ROLES } from "@/lib/labels";
import { SubmitButton } from "./submit-button";

type InitialArticle = {
  id: string;
  title: string;
  body: string;
  category: string;
  published: boolean;
  roles: string[];
};

export function ArticleForm({ initial }: { initial: InitialArticle | null }) {
  const action = saveArticle.bind(null, initial?.id ?? null);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-5">
      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="title">Title</label>
          <input
            id="title"
            name="title"
            required
            defaultValue={initial?.title ?? ""}
            className="input"
            placeholder='e.g. "How to connect to school Wi-Fi"'
          />
        </div>
        <div>
          <label className="label" htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue={initial?.category ?? "TECHNOLOGY"} className="input">
            {Object.entries(CATEGORIES).map(([value, c]) => (
              <option key={value} value={value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className="label">Who can read this?</legend>
        <div className="flex flex-wrap gap-3">
          {Object.entries(USER_ROLES).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm font-medium shadow-sm has-checked:border-blue-600 has-checked:bg-blue-50"
            >
              <input
                type="checkbox"
                name="roles"
                value={value}
                defaultChecked={initial ? initial.roles.includes(value) : true}
                className="accent-blue-600"
              />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          The help desk team can always read everything, including drafts.
        </p>
      </fieldset>

      <div>
        <label className="label" htmlFor="body">
          Article <span className="font-normal text-slate-400">(Markdown: ## headings, **bold**, - lists, links)</span>
        </label>
        <textarea
          id="body"
          name="body"
          required
          rows={16}
          defaultValue={initial?.body ?? ""}
          className="input font-mono text-xs"
          placeholder={"## Symptoms\n\n- Wi-Fi icon shows an X\n\n## Fix\n\n1. Click the clock in the corner…"}
        />
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          name="published"
          defaultChecked={initial?.published ?? false}
          className="accent-blue-600"
        />
        Published — visible in the Help Center
      </label>

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Saving…">Save article</SubmitButton>
        <a href="/dashboard/kb" className="text-sm font-medium text-slate-500 hover:underline">
          Cancel
        </a>
      </div>
    </form>
  );
}
