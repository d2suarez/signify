"use client";

import { useActionState } from "react";
import { sendTestEmail, type FormState } from "@/lib/actions";
import { SubmitButton } from "./submit-button";

export function TestEmail() {
  const [state, formAction] = useActionState<FormState, FormData>(sendTestEmail, {});

  return (
    <form action={formAction} className="space-y-3">
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
      <SubmitButton className="btn-secondary" pendingText="Sending…">
        Send me a test email
      </SubmitButton>
    </form>
  );
}
