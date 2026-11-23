"use client";

import { useMemo, useState } from "react";
import { groupName, newGroupId, randomGroups, ungrouped, GROUP_LIMITS, type Group, type GroupMember } from "@/lib/groups";
import type { GroupSet } from "@/lib/group-sets";
import type { Dict } from "@/lib/i18n";

/**
 * One group set, changed by hand (story 01, A8): rename the set and its
 * groups, move each student with a list (no dragging, so it works with a
 * keyboard and a screen reader), add or remove groups, or deal the class out
 * again at random. Saved with the version it started from.
 */
export default function GroupsEditor({ courseId, initial, people, d }: {
  courseId: string; initial: GroupSet; people: GroupMember[] | null; d: Dict;
}) {
  const [name, setName] = useState(initial.name);
  const [groups, setGroups] = useState<Group[]>(initial.groups);
  const [studentsSee, setStudentsSee] = useState(initial.studentsSee);
  const [version, setVersion] = useState(initial.version);
  const [status, setStatus] = useState<"" | "dirty" | "saving" | "saved" | "conflict" | "failed">("");
  const [how, setHow] = useState<"count" | "size">("count");
  const [n, setN] = useState(Math.max(1, initial.groups.length || 4));

  const loose = useMemo(() => (people ? ungrouped(groups, people) : []), [groups, people]);
  const change = (next: Group[]) => { setGroups(next); setStatus("dirty"); };

  function moveTo(member: GroupMember, to: string) {
    const out = groups.map((g) => ({ ...g, members: g.members.filter((m) => m.id !== member.id) }));
    const target = out.find((g) => g.id === to);
    if (target) target.members.push(member);
    change(out);
  }

  function addGroup() {
    if (groups.length >= GROUP_LIMITS.groups) return;
    change([...groups, { id: newGroupId(), name: groupName(d.grpWord, groups.length), members: [] }]);
  }

  function removeGroup(id: string) {
    change(groups.filter((g) => g.id !== id));
  }

  function shuffle() {
    if (!people) return;
    change(randomGroups(people, how === "size" ? { size: n } : { count: n }, d.grpWord));
  }

  async function save() {
    setStatus("saving");
    try {
      const res = await fetch(`/api/courses/${courseId}/groups/${initial.id}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: version, name, groups, studentsSee }),
      });
      if (res.status === 409) { setStatus("conflict"); return; }
      if (!res.ok) { setStatus("failed"); return; }
      const { set } = await res.json() as { set: GroupSet };
      setVersion(set.version); setGroups(set.groups); setName(set.name);
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  }

  const choice = (m: GroupMember, current: string) => (
    <select className="field" aria-label={d.grpMoveLabel.replace("{name}", m.name)} value={current} onChange={(e) => moveTo(m, e.target.value)}>
      <option value="">{d.grpNoGroup}</option>
      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="fieldset">
        <label htmlFor="grp-set-name">{d.grpSetName}</label>
        <input id="grp-set-name" className="field" value={name} maxLength={GROUP_LIMITS.setName}
          onChange={(e) => { setName(e.target.value); setStatus("dirty"); }} style={{ fontSize: 22, fontWeight: 800 }} />
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={studentsSee} onChange={(e) => { setStudentsSee(e.target.checked); setStatus("dirty"); }} />
        <span>{d.grpStudentsSee}</span>
      </label>

      <section className="card stack" style={{ gap: 8, padding: "12px 14px" }} aria-labelledby="grp-shuffle">
        <h2 id="grp-shuffle" style={{ fontSize: 18 }}>{d.grpShuffle}</h2>
        <div className="row">
          <select className="field" style={{ width: "auto" }} value={how} onChange={(e) => setHow(e.target.value as "count" | "size")} aria-label={d.grpHow}>
            <option value="count">{d.grpHowCount}</option>
            <option value="size">{d.grpHowSize}</option>
          </select>
          <input type="number" className="field" style={{ width: "min(6em, 100%)" }} min={1} max={40} value={n}
            onChange={(e) => setN(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} aria-label={d.grpHowN} />
          <button type="button" className="btn" onClick={shuffle} disabled={!people || !people.length}>{d.grpShuffleGo}</button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.grpNoApart}</p>
      </section>

      <div className="grp-edit">
        {groups.map((g, gi) => (
          <section key={g.id} className="card" aria-label={g.name}>
            <div className="row" style={{ gap: 6, marginBottom: 6 }}>
              <input className="field" style={{ flex: "1 1 8em", width: "auto", fontWeight: 800 }} value={g.name} maxLength={GROUP_LIMITS.name}
                aria-label={d.grpGroupName.replace("{n}", String(gi + 1))}
                onChange={(e) => change(groups.map((x) => (x.id === g.id ? { ...x, name: e.target.value } : x)))} />
              <button type="button" className="btn btn-sm" onClick={() => removeGroup(g.id)}>{d.grpRemoveGroup}</button>
            </div>
            {g.members.length === 0 && <p className="muted" style={{ margin: 0 }}>{d.grpEmpty}</p>}
            {g.members.map((m) => (
              <div key={m.id} className="grp-member">
                <span className="grow">{m.name}</span>
                {choice(m, g.id)}
              </div>
            ))}
          </section>
        ))}
        {people && (
          <section className="card" aria-label={d.grpNoGroup}>
            <p className="label" style={{ marginTop: 0 }}>{d.grpNoGroup} ({loose.length})</p>
            {loose.length === 0 && <p className="muted" style={{ margin: 0 }}>{d.grpAllPlaced}</p>}
            {loose.map((m) => (
              <div key={m.id} className="grp-member">
                <span className="grow">{m.name}</span>
                {choice(m, "")}
              </div>
            ))}
          </section>
        )}
      </div>

      <div className="row">
        <button type="button" className="btn" onClick={addGroup} disabled={groups.length >= GROUP_LIMITS.groups}>+ {d.grpAddGroup}</button>
        <span style={{ flex: 1 }} />
        <span className="muted" role="status" aria-live="polite">
          {status === "saving" ? d.saving : status === "saved" ? d.saved : status === "dirty" ? d.unsaved
            : status === "conflict" ? d.grpConflict : status === "failed" ? d.grpSaveFailed : ""}
        </span>
        <button type="button" className="btn btn-primary" onClick={save} disabled={status === "saving" || status === "conflict" || !people}>{d.grpSave}</button>
      </div>
    </div>
  );
}
