"use client";

import { useActionState, useEffect, useRef } from "react";
import { addRequesterReply, type FormState } from "@/lib/actions";
import { SubmitButton } from "./submit-button";

export function ReplyForm({
  token,
  placeholder = "Add more details or reply to the team…",
  sendLabel = "Send reply",
  sendingLabel = "Sending…",
}: {
  token: string;
  placeholder?: string;
  sendLabel?: string;
  sendingLabel?: string;
}) {
  const action = addRequesterReply.bind(null, token);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.message) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.error}
        </div>
      )}
      {state.message && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {state.message}
        </div>
      )}
      <textarea name="body" rows={3} required className="input" placeholder={placeholder} />
      <SubmitButton pendingText={sendingLabel}>{sendLabel}</SubmitButton>
    </form>
  );
}
