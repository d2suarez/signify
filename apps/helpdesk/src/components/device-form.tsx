"use client";

import { useActionState, useEffect, useRef } from "react";
import { saveDevice, type FormState } from "@/lib/actions";
import { DEVICE_STATUSES, DEVICE_TYPES } from "@/lib/labels";
import { SubmitButton } from "./submit-button";

type InitialDevice = {
  id: string;
  tag: string;
  type: string;
  model: string;
  location: string;
  assignedTo: string;
  status: string;
  notes: string;
};

export function DeviceForm({ initial }: { initial: InitialDevice | null }) {
  const action = saveDevice.bind(null, initial?.id ?? null);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.message && !initial) formRef.current?.reset();
  }, [state, initial]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
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

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="tag">Asset tag</label>
          <input id="tag" name="tag" required defaultValue={initial?.tag ?? ""} className="input" placeholder="C-104" />
        </div>
        <div>
          <label className="label" htmlFor="type">Type</label>
          <select id="type" name="type" defaultValue={initial?.type ?? "CHROMEBOOK"} className="input">
            {Object.entries(DEVICE_TYPES).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={initial?.status ?? "ACTIVE"} className="input">
            {Object.entries(DEVICE_STATUSES).map(([value, s]) => (
              <option key={value} value={value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="model">
            Model <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input id="model" name="model" defaultValue={initial?.model ?? ""} className="input" placeholder="Lenovo 100e" />
        </div>
        <div>
          <label className="label" htmlFor="location">
            Location <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input id="location" name="location" defaultValue={initial?.location ?? ""} className="input" placeholder="Cart 2 / Room 14" />
        </div>
        <div>
          <label className="label" htmlFor="assignedTo">
            Assigned to <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input id="assignedTo" name="assignedTo" defaultValue={initial?.assignedTo ?? ""} className="input" placeholder="Person or cart" />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="notes">
          Notes <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <textarea id="notes" name="notes" rows={2} defaultValue={initial?.notes ?? ""} className="input" />
      </div>

      <SubmitButton pendingText="Saving…">{initial ? "Save device" : "Add device"}</SubmitButton>
    </form>
  );
}
