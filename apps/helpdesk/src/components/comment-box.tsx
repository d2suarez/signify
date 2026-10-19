"use client";

import { useRef } from "react";
import { addStaffComment } from "@/lib/actions";
import { SubmitButton } from "./submit-button";

type SnippetOption = { id: string; title: string; body: string };

export function CommentBox({
  ticketId,
  snippets,
}: {
  ticketId: number;
  snippets: SnippetOption[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const action = addStaffComment.bind(null, ticketId);

  function insertSnippet(id: string) {
    const snippet = snippets.find((s) => s.id === id);
    const textarea = textareaRef.current;
    if (!snippet || !textarea) return;
    textarea.value = textarea.value
      ? `${textarea.value.replace(/\s+$/, "")}\n\n${snippet.body}`
      : snippet.body;
    textarea.focus();
  }

  return (
    <form action={action} className="space-y-3">
      <textarea
        ref={textareaRef}
        name="body"
        rows={3}
        required
        className="input"
        placeholder="Write an update… (public updates are visible to the requester)"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" name="internal" className="accent-amber-500" />
            Internal note
          </label>
          {snippets.length > 0 && (
            <select
              className="input w-auto py-1.5 text-xs"
              defaultValue=""
              aria-label="Insert saved reply"
              onChange={(event) => {
                insertSnippet(event.target.value);
                event.target.value = "";
              }}
            >
              <option value="" disabled>
                Insert saved reply…
              </option>
              {snippets.map((snippet) => (
                <option key={snippet.id} value={snippet.id}>
                  {snippet.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <SubmitButton pendingText="Posting…">Post update</SubmitButton>
      </div>
    </form>
  );
}
