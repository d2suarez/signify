"use client";

import { useActionState, useEffect, useState } from "react";
import { submitTicket, type FormState } from "@/lib/actions";
import type { Dict } from "@/lib/i18n";
import { SubmitButton } from "./submit-button";

type Suggestion = { title: string; slug: string };

export type SubmitPrefill = {
  deviceTag: string;
  deviceLabel: string;
  location: string;
};

export function SubmitForm({
  t,
  prefill = null,
}: {
  t: Dict;
  prefill?: SubmitPrefill | null;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(submitTicket, {});
  const [title, setTitle] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    if (title.trim().length < 4) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/kb-suggest?q=${encodeURIComponent(title)}`)
        .then((res) => (res.ok ? res.json() : []))
        .then((data) => setSuggestions(Array.isArray(data) ? data : []))
        .catch(() => setSuggestions([]));
    }, 350);
    return () => clearTimeout(timer);
  }, [title]);

  const categoryOptions = [
    { value: "TECHNOLOGY", shape: "square", tone: "text-p2", label: t.catTech, hint: t.catTechHint },
    { value: "MAINTENANCE", shape: "circle", tone: "text-p1", label: t.catMaint, hint: t.catMaintHint },
    { value: "OTHER", shape: "arch", tone: "text-p4", label: t.catOther, hint: t.catOtherHint },
  ];

  return (
    <form action={formAction} className="space-y-6">
      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      )}

      {prefill && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {t.aboutDevice} <strong>{prefill.deviceLabel}</strong>
          {prefill.location ? ` (${prefill.location})` : ""}.
          <input type="hidden" name="deviceTag" value={prefill.deviceTag} />
        </div>
      )}

      <fieldset>
        <legend className="label">{t.kindLabel}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {categoryOptions.map((option) => (
            <label
              key={option.value}
              className="cursor-pointer rounded-lg border border-slate-300 bg-surface p-3 shadow-sm transition has-checked:border-blue-600 has-checked:bg-blue-50"
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <input type="radio" name="category" value={option.value} required className="accent-blue-600" />
                <span aria-hidden className={`shape shape-${option.shape} ${option.tone}`} />
                {option.label}
              </span>
              <span className="mt-1 block pl-6 text-xs text-slate-500">{option.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label className="label" htmlFor="title">{t.titleLabel}</label>
        <input
          id="title"
          name="title"
          required
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="input"
          placeholder={t.titlePlaceholder}
        />
        {suggestions.length > 0 && (
          <div className="mt-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm">
            <p className="font-medium text-green-900">{t.suggestHeading}</p>
            <ul className="mt-1 space-y-0.5">
              {suggestions.map((s) => (
                <li key={s.slug}>
                  <a
                    href={`/kb/${s.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-green-800 underline hover:text-green-950"
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <label className="label" htmlFor="description">
          {t.detailsLabel} <span className="font-normal text-slate-400">{t.detailsHint}</span>
        </label>
        <textarea id="description" name="description" rows={4} className="input" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="location">
            {t.locationLabel} <span className="font-normal text-slate-400">{t.optional}</span>
          </label>
          <input
            id="location"
            name="location"
            defaultValue={prefill?.location ?? ""}
            className="input"
            placeholder={t.locationPlaceholder}
          />
        </div>
        <div>
          <label className="label" htmlFor="device">
            {t.deviceLabel} <span className="font-normal text-slate-400">{t.optional}</span>
          </label>
          <input
            id="device"
            name="device"
            defaultValue={prefill?.deviceLabel ?? ""}
            className="input"
            placeholder={t.devicePlaceholder}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="priority">{t.urgencyLabel}</label>
          <select id="priority" name="priority" defaultValue="NORMAL" className="input">
            <option value="LOW">{t.urgLow}</option>
            <option value="NORMAL">{t.urgNormal}</option>
            <option value="HIGH">{t.urgHigh}</option>
            <option value="URGENT">{t.urgUrgent}</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="photos">
            {t.photosLabel} <span className="font-normal text-slate-400">{t.photosHint}</span>
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
      </div>

      <SubmitButton className="btn-primary w-full py-3 text-base" pendingText={t.submittingBtn}>
        {t.submitBtn}
      </SubmitButton>
    </form>
  );
}
