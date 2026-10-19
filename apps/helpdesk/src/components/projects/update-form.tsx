"use client";

import { useActionState, useEffect, useRef } from "react";
import { postUpdate } from "@/lib/project-actions";
import type { FormState } from "@/lib/actions";
import { SubmitButton } from "../submit-button";

export function UpdateForm({ projectId }: { projectId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(postUpdate.bind(null, projectId), {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.message) ref.current?.reset(); }, [state]);
  return (
    <form ref={ref} action={formAction} className="card space-y-3 p-4">
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      <label className="sr-only" htmlFor="u-body">Post an update</label>
      <textarea id="u-body" name="body" rows={3} required className="input" placeholder="Where things stand, a question for the group, a decision you made" />
      <SubmitButton pendingText="Posting…">Post update</SubmitButton>
    </form>
  );
}
