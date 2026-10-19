"use client";

import { useActionState } from "react";
import { saveNotificationPrefs, type FormState } from "@/lib/actions";
import type { EventDef, NotifyPrefs } from "@/lib/notify-prefs";
import { SubmitButton } from "./submit-button";

export function NotificationPrefsForm({
  events,
  prefs,
  phone,
  emailAvailable,
  smsAvailable,
}: {
  events: EventDef[];
  prefs: NotifyPrefs;
  phone: string;
  emailAvailable: boolean;
  smsAvailable: boolean;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(saveNotificationPrefs, {});

  const channels: { key: "email" | "push" | "sms"; label: string; available: boolean }[] = [
    { key: "email", label: "Email", available: emailAvailable },
    { key: "push", label: "Push", available: true },
    { key: "sms", label: "Text", available: smsAvailable },
  ];

  return (
    <form action={formAction} className="space-y-4">
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

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2 pr-4 font-semibold">Notify me about…</th>
              {channels.map((channel) => (
                <th key={channel.key} className="px-3 py-2 text-center font-semibold">
                  {channel.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((event) => (
              <tr key={event.key}>
                <td className="py-3 pr-4">
                  <p className="font-medium text-slate-800">{event.label}</p>
                  <p className="text-xs text-slate-500">{event.description}</p>
                </td>
                {channels.map((channel) => (
                  <td key={channel.key} className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      name={`pref_${event.key}_${channel.key}`}
                      defaultChecked={prefs[event.key]?.[channel.key] ?? false}
                      className="size-4 accent-blue-600"
                      aria-label={`${event.label} via ${channel.label}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(!emailAvailable || !smsAvailable) && (
        <p className="text-xs text-slate-400">
          {!emailAvailable && "Email sending isn't configured on the server yet. "}
          {!smsAvailable && "Text messaging isn't configured on the server yet. "}
          Your choices are saved and take effect once it's set up.
        </p>
      )}

      <div>
        <label className="label" htmlFor="phone">
          Cell phone <span className="font-normal text-slate-400">(for text notifications)</span>
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={phone}
          className="input sm:w-64"
          placeholder="555-123-4567"
        />
      </div>

      <SubmitButton pendingText="Saving…">Save notification settings</SubmitButton>
    </form>
  );
}
