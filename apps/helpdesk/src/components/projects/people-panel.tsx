"use client";

import { useActionState, useEffect, useState } from "react";
import { addMember, removeMember, searchPeople, setMemberRole } from "@/lib/project-actions";
import type { FormState } from "@/lib/actions";
import { SubmitButton } from "../submit-button";

export type PersonDTO = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  picture: string;
  roleLabel: string;
  projectRole: string;
  isOwner: boolean;
  isMe: boolean;
  joined: boolean; // false = a placeholder who has not signed in yet
};

const ROLES = [
  { value: "LEAD", label: "Lead", hint: "Can change the project and who is on it" },
  { value: "EDITOR", label: "Helper", hint: "Can add and move tasks and post updates" },
  { value: "VIEWER", label: "Watching", hint: "Can see the project, but not change it" },
];

type Found = { id: string; name: string; email: string; roleLabel: string; role: string; picture: string };

function Avatar({ name, picture }: { name: string; picture: string }) {
  return picture ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={picture} alt="" referrerPolicy="no-referrer" className="h-9 w-9 flex-none rounded-full" />
  ) : (
    <span aria-hidden className="grid h-9 w-9 flex-none place-items-center rounded-full bg-blue-100 text-sm font-bold text-blue-800">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PeoplePanel({ projectId, people, manage }: { projectId: string; people: PersonDTO[]; manage: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(addMember.bind(null, projectId), {});
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);

  useEffect(() => {
    if (picked || q.trim().length < 2) { setFound([]); return; }
    const timer = setTimeout(() => {
      searchPeople(projectId, q).then(setFound).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, picked, projectId]);

  useEffect(() => {
    if (state.message) { setQ(""); setPicked(null); }
  }, [state]);

  const looksLikeEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q.trim());

  return (
    <div className="space-y-6">
      <ul className="card divide-y divide-slate-100">
        {people.map((p) => (
          <li key={p.memberId} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Avatar name={p.name} picture={p.picture} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">
                {p.name}
                {p.isMe && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}
              </p>
              <p className="truncate text-xs text-slate-500">
                {p.roleLabel || p.email}
                {!p.joined && " · hasn't opened the help desk yet"}
              </p>
            </div>
            {p.isOwner ? (
              <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-800">Started it</span>
            ) : manage ? (
              <>
                <form action={setMemberRole.bind(null, projectId, p.memberId)}>
                  <select
                    name="role"
                    defaultValue={p.projectRole}
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                    className="input w-auto py-1.5 text-xs"
                    aria-label={`What ${p.name} can do`}
                  >
                    {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </form>
                <form action={removeMember.bind(null, projectId, p.memberId)}>
                  <SubmitButton className="btn-ghost text-xs" pendingText="…">Remove</SubmitButton>
                </form>
              </>
            ) : (
              <>
                <span className="text-xs font-semibold text-slate-600">{ROLES.find((r) => r.value === p.projectRole)?.label}</span>
                {p.isMe && (
                  <form action={removeMember.bind(null, projectId, p.memberId)}>
                    <SubmitButton className="btn-ghost text-xs" pendingText="…">Leave</SubmitButton>
                  </form>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      {manage && (
        <form action={formAction} className="card space-y-4 p-5">
          <h3 className="text-lg font-bold">Add someone</h3>
          {state.error && <p className="rounded-[var(--radius-md)] bg-red-50 px-4 py-3 text-sm text-red-800">{state.error}</p>}
          {state.message && <p className="rounded-[var(--radius-md)] bg-green-50 px-4 py-3 text-sm text-green-800">{state.message}</p>}

          <div className="relative">
            <label className="label" htmlFor="who">Name or school email</label>
            {picked ? (
              <div className="inset flex items-center gap-3 p-2.5">
                <Avatar name={picked.name} picture={picked.picture} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{picked.name}</p>
                  <p className="truncate text-xs text-slate-500">{picked.email}</p>
                </div>
                <button type="button" className="btn-ghost text-xs" onClick={() => setPicked(null)}>Change</button>
                <input type="hidden" name="userId" value={picked.id} />
              </div>
            ) : (
              <>
                <input
                  id="who"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  autoComplete="off"
                  className="input"
                  placeholder="Start typing a name"
                />
                <input type="hidden" name="email" value={looksLikeEmail ? q.trim() : ""} />
                {found.length > 0 && (
                  <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-[var(--radius-md)] bg-surface shadow-[var(--shadow-4)]">
                    {found.map((f) => (
                      <li key={f.id}>
                        <button type="button" onClick={() => setPicked(f)} className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-slate-50">
                          <Avatar name={f.name} picture={f.picture} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{f.name}</span>
                            <span className="block truncate text-xs text-slate-500">{f.roleLabel || f.email}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-xs text-slate-500">
                  Only people who have opened the help desk show up here. For anyone else, type their whole school email.
                </p>
              </>
            )}
          </div>

          <div>
            <label className="label" htmlFor="role">What they can do</label>
            <select id="role" name="role" defaultValue="EDITOR" className="input sm:w-80">
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>)}
            </select>
          </div>
          <SubmitButton pendingText="Adding…">Add to project</SubmitButton>
        </form>
      )}
    </div>
  );
}
