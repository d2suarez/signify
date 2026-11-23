"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Block, type BlockType, type FileBlock, newBlock, newId, webLink, fileUrl, LIMITS } from "@/lib/blocks";
import { boardLink } from "@/lib/boards";
import type { Lesson } from "@/lib/lessons";
import { BLOCK_NAME, BLOCK_SHAPE } from "@/lib/block-kinds";
import type { Dict } from "@/lib/i18n";
import ToolPicker, { type PlacedItem, type ToolChoice } from "./ToolPicker";

type Status = "saved" | "dirty" | "saving" | "error" | "conflict";
type Version = { version: number; title: string; blockCount: number; savedAt: string };

const SAVE_DELAY = 800;

const SHAPE = BLOCK_SHAPE;
const NAME = BLOCK_NAME;
/** The add-a-block buttons, in order: content and questions, then the Desk tools, then Boards and links. */
const ADD: BlockType[] = ["text", "poll", "timer", "picker", "noise", "board", "link", "file"];

/** A class resource the editor can add: the blocks it becomes (src/lib/resources.ts, resourceChoices). */
export type ResourceChoice = { id: string; title: string; kind: BlockType | "lesson"; blocks: Block[] };

/** One of the class's saved group sets, for a group slide. */
export type GroupSetChoice = { id: string; name: string };

/** One of the course's assignments or quizzes, for an assignment slide. */
export type AssignmentChoice = { id: string; title: string; kind: string; published: boolean };

export default function LessonEditor({ initial, courseId, units = [], tools = [], resources = [], assignments = [], groupSets = [], d }: {
  initial: Lesson; courseId: string; units?: { id: string; title: string }[]; tools?: ToolChoice[]; resources?: ResourceChoice[];
  assignments?: AssignmentChoice[];
  /** The class's saved group sets (group slides). */
  groupSets?: GroupSetChoice[]; d: Dict;
}) {
  const [title, setTitle] = useState(initial.title);
  const [blocks, setBlocks] = useState<Block[]>(initial.blocks);
  const [plannedFor, setPlannedFor] = useState(initial.plannedFor || "");
  const [durationMin, setDurationMin] = useState(initial.durationMin);
  const [unitId, setUnitId] = useState(initial.unitId || "");
  const [version, setVersion] = useState(initial.version);
  const [status, setStatus] = useState<Status>("saved");
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [resPick, setResPick] = useState(resources[0]?.id ?? "");
  const [resNote, setResNote] = useState("");

  // What the next save sends, read at save time so a slow save never sends stale text.
  const latest = useRef({ title, blocks, plannedFor, durationMin, unitId, version });
  latest.current = { title, blocks, plannedFor, durationMin, unitId, version };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);

  const save = useCallback(async () => {
    if (stopped.current) return;
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    setStatus("saving");
    const s = latest.current;
    try {
      const res = await fetch(`/api/lessons/${initial.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: s.version, title: s.title, blocks: s.blocks, plannedFor: s.plannedFor || null, durationMin: s.durationMin, unitId: s.unitId || null }),
      });
      if (res.status === 409) {
        stopped.current = true;
        setStatus("conflict");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      latest.current.version = body.lesson.version;
      setVersion(body.lesson.version);
      if (body.changed && versions) setVersions(null); // reload the list next time it is opened
      setStatus(again.current ? "dirty" : "saved");
    } catch {
      setStatus("error");
      // Keep trying: the work is on this page, and a blip must not lose it.
      timer.current = setTimeout(save, 4000);
    } finally {
      inFlight.current = false;
      if (again.current) { again.current = false; save(); }
    }
  }, [initial.id, versions]);

  const touch = useCallback(() => {
    if (stopped.current) return;
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_DELAY);
  }, [save]);

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (status === "dirty" || status === "saving" || status === "error") { e.preventDefault(); }
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status]);

  const update = (i: number, patch: Partial<Block>) => {
    setBlocks((bs) => bs.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)));
    touch();
  };
  const move = (i: number, by: number) => {
    setBlocks((bs) => {
      const j = i + by;
      if (j < 0 || j >= bs.length) return bs;
      const out = bs.slice();
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
    touch();
  };
  const remove = (i: number) => { setBlocks((bs) => bs.filter((_, j) => j !== i)); touch(); };
  const add = (type: BlockType) => {
    if (blocks.length >= LIMITS.blocks) return;
    setBlocks((bs) => [...bs, newBlock(type)]);
    touch();
  };

  // Outside tools come back from the tool's picker (or as its own page) as tool blocks.
  const addTools = (items: PlacedItem[]) => {
    if (!items.length) return;
    setBlocks((bs) => [...bs, ...items.map((it) => ({ id: newId(), type: "tool" as const, title: it.title, linkId: it.linkId, display: it.display }))]
      .slice(0, LIMITS.blocks));
    touch();
  };

  // A class resource comes in as a copy with fresh ids (adding one twice gives two).
  const addResource = () => {
    const r = resources.find((x) => x.id === resPick);
    if (!r || !r.blocks.length) return;
    setBlocks((bs) => [...bs, ...r.blocks.map((b) => ({ ...b, id: newId() }) as Block)].slice(0, LIMITS.blocks));
    setResNote(`${d.resAdded}: ${r.title}`);
    touch();
  };
  const saveToResources = async (b: Block) => {
    setResNote("");
    try {
      const res = await fetch(`/api/courses/${courseId}/resources`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ block: b }),
      });
      setResNote(res.ok ? d.resSavedBlock : d.resSaveFailed);
    } catch {
      setResNote(d.resSaveFailed);
    }
  };

  const loadVersions = async () => {
    const res = await fetch(`/api/lessons/${initial.id}/versions`, { cache: "no-store" });
    if (res.ok) setVersions((await res.json()).versions);
  };
  const restore = async (v: number) => {
    if (status !== "saved") return;
    const res = await fetch(`/api/lessons/${initial.id}/versions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: v, baseVersion: version }),
    });
    if (res.status === 409) { stopped.current = true; setStatus("conflict"); return; }
    if (!res.ok) return;
    const { lesson } = await res.json();
    setTitle(lesson.title); setBlocks(lesson.blocks); setVersion(lesson.version);
    latest.current.version = lesson.version;
    loadVersions();
  };

  const stateText = {
    saved: `${d.saved} · ${d.version} ${version}`,
    dirty: d.unsaved,
    saving: d.saving,
    error: d.saveFailed,
    conflict: "",
  }[status];

  return (
    <div className="stack">
      <div className="row">
        <Link href={`/courses/${courseId}`} className="muted" style={{ fontSize: 14 }}>← {d.backToCourse}</Link>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="save-state" role="status" aria-live="polite">{stateText}</span>
        <Link className="btn btn-primary" href={`/lessons/${initial.id}/present`}>{d.present}</Link>
      </div>

      {status === "conflict" && (
        <div className="notice notice-bad" role="alert">
          {d.conflict} <button className="btn btn-sm" type="button" onClick={() => location.reload()}>{d.reload}</button>
        </div>
      )}

      <div className="editor">
        <div className="editor-main">
          <label htmlFor="lesson-title" className="label">{d.lessonTitle}</label>
          <input id="lesson-title" className="title-input" value={title} maxLength={200}
            onChange={(e) => { setTitle(e.target.value); touch(); }} />

          {blocks.length === 0 && <p className="empty">{d.emptyLesson}</p>}

          {blocks.map((b, i) => (
            <section key={b.id} className="card block-card" aria-label={`${i + 1}`}>
              <div className="block-head">
                <span className={`shape ${SHAPE[b.type]}`} />
                <span className="label">{i + 1} · {d[NAME[b.type]]}</span>
                <span className="spacer" />
                <button type="button" className="icon-btn" aria-label={d.moveUp} disabled={i === 0} onClick={() => move(i, -1)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                </button>
                <button type="button" className="icon-btn" aria-label={d.moveDown} disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {b.type !== "assignment" && b.type !== "groups" && (
                  <button type="button" className="icon-btn" aria-label={`${d.resSaveBlock}: ${i + 1}`} title={d.resSaveBlock} onClick={() => saveToResources(b)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={d.remove} onClick={() => remove(i)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <BlockFields block={b} d={d} onChange={(p) => update(i, p)} idBase={`b${i}`} courseId={courseId} assignments={assignments} groupSets={groupSets} />
            </section>
          ))}

          <div className="card" style={{ padding: "14px 16px" }}>
            <p className="label">{d.addBlock}</p>
            <div className="row" style={{ marginTop: 10 }}>
              {[...ADD, ...(assignments.length ? ["assignment" as const] : []), "groups" as const].map((type) => (
                <button key={type} type="button" className="btn" onClick={() => add(type)}><span className={`shape ${SHAPE[type]}`} />{d[NAME[type]]}</button>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <label className="label" htmlFor="res-pick">{d.resFromResources}</label>
              {resources.length === 0
                ? <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>{d.resNoneInEditor} <Link href={`/courses/${courseId}/resources`}>{d.resTitle}</Link></p>
                : (
                  <div className="row" style={{ marginTop: 8 }}>
                    <select id="res-pick" className="field" style={{ flex: "1 1 220px", width: "auto" }} value={resPick} onChange={(e) => setResPick(e.target.value)}>
                      {resources.map((r) => (
                        <option key={r.id} value={r.id}>{r.title} · {r.kind === "lesson" ? `${d.lesson} (${r.blocks.length} ${d.blocks})` : d[NAME[r.kind]]}</option>
                      ))}
                    </select>
                    <button type="button" className="btn" onClick={addResource} disabled={!resPick}>{d.add}</button>
                  </div>
                )}
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.resFromHint}</p>
              <p role="status" aria-live="polite" style={{ margin: "6px 0 0", fontSize: 14 }}>{resNote}</p>
            </div>
            {tools.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p className="label">{d.toolAddLesson}</p>
                <ToolPicker tools={tools} courseId={courseId} lessonId={initial.id} onPlaced={addTools} d={d} />
              </div>
            )}
          </div>
        </div>

        <aside className="editor-side">
          <div className="card">
            {units.length > 0 && (
              <div className="fieldset" style={{ marginTop: 0 }}>
                <label htmlFor="unit">{d.unit}</label>
                <select id="unit" className="field" value={unitId} onChange={(e) => { setUnitId(e.target.value); touch(); }}>
                  <option value="">{d.noUnit}</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
                </select>
              </div>
            )}
            <div className="fieldset" style={{ marginTop: units.length > 0 ? 10 : 0 }}>
              <label htmlFor="planned">{d.plannedFor}</label>
              <input id="planned" type="date" className="field" value={plannedFor} onChange={(e) => { setPlannedFor(e.target.value); touch(); }} />
            </div>
            <div className="fieldset">
              <label htmlFor="dur">{d.duration}</label>
              <input id="dur" type="number" min={5} max={600} className="field" value={durationMin}
                onChange={(e) => { setDurationMin(Number(e.target.value) || 50); touch(); }} />
            </div>
          </div>

          {initial.studentView && initial.studentView !== "hidden" && version > initial.version && (
            <TellClass lessonId={initial.id} d={d} />
          )}

          <div className="card">
            <div className="row">
              <p className="label">{d.earlierVersions}</p>
              <span className="spacer" style={{ flex: 1 }} />
              {versions === null && <button type="button" className="btn btn-sm" onClick={loadVersions}>{d.earlierVersions}</button>}
            </div>
            {versions && versions.length === 0 && <p className="empty" style={{ fontSize: 14 }}>{d.noVersions}</p>}
            {versions && versions.length > 0 && (
              <ul className="list" style={{ marginTop: 8 }}>
                {versions.slice(0, 20).map((v) => (
                  <li key={v.version} style={{ padding: "8px 0" }}>
                    <span className="grow" style={{ minWidth: 0, fontSize: 14 }}>
                      <b>{d.version} {v.version}</b> · {v.blockCount} {d.blocks}
                      <br /><span className="muted" style={{ fontSize: 12 }}>{new Date(v.savedAt).toLocaleString()}</span>
                    </span>
                    <button type="button" className="btn btn-sm" disabled={status !== "saved"} onClick={() => restore(v.version)}>{d.restore}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function BlockFields({ block: b, d, onChange, idBase, courseId, assignments = [], groupSets = [] }: {
  block: Block; d: Dict; onChange: (p: Partial<Block>) => void; idBase: string;
  /** Where an uploaded file belongs (file blocks). */
  courseId?: string;
  /** The course's assignments and quizzes (assignment slides). */
  assignments?: AssignmentChoice[];
  /** The class's group sets (group slides). */
  groupSets?: GroupSetChoice[];
}) {
  if (b.type === "groups") {
    const known = groupSets.some((g) => g.id === b.groupSetId);
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-g`}>{d.grpSlideChoose}</label>
          <select id={`${idBase}-g`} className="field" value={b.groupSetId}
            onChange={(e) => onChange({ groupSetId: e.target.value, title: groupSets.find((g) => g.id === e.target.value)?.name ?? "" } as Partial<Block>)}>
            <option value="">{d.grpSlidePick}</option>
            {b.groupSetId && !known && <option value={b.groupSetId}>{b.title || d.blockGroups}</option>}
            {groupSets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {d.grpSlideHint} {courseId && <Link href={`/courses/${courseId}/groups`}>{d.grpTitle}</Link>}
        </p>
      </>
    );
  }
  if (b.type === "assignment") {
    const known = assignments.some((a) => a.id === b.assignmentId);
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-a`}>{d.asgSlideChoose}</label>
          <select id={`${idBase}-a`} className="field" value={b.assignmentId}
            onChange={(e) => onChange({ assignmentId: e.target.value, title: assignments.find((a) => a.id === e.target.value)?.title ?? "" } as Partial<Block>)}>
            <option value="">{d.asgSlidePick}</option>
            {b.assignmentId && !known && <option value={b.assignmentId}>{b.title || d.blockAssignment}</option>}
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>{a.title} · {a.kind === "quiz" ? d.quizWord : d.pcKindAssignment}{a.published ? "" : ` · ${d.pcDraft}`}</option>
            ))}
          </select>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.asgSlideHint}</p>
      </>
    );
  }
  if (b.type === "file") return <FileFields block={b} d={d} onChange={onChange} idBase={idBase} courseId={courseId} />;
  if (b.type === "text") {
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-t`}>{d.title}</label>
          <input id={`${idBase}-t`} className="field" value={b.title} maxLength={LIMITS.title} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div className="fieldset">
          <label htmlFor={`${idBase}-b`}>{d.body}</label>
          <textarea id={`${idBase}-b`} className="field" rows={4} value={b.body} maxLength={LIMITS.body} onChange={(e) => onChange({ body: e.target.value })} />
        </div>
      </>
    );
  }
  if (b.type === "poll") {
    const setChoice = (i: number, patch: Partial<(typeof b.choices)[number]>) =>
      onChange({ choices: b.choices.map((c, j) => (j === i ? { ...c, ...patch } : c)) } as Partial<Block>);
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-q`}>{d.question}</label>
          <textarea id={`${idBase}-q`} className="field" rows={2} style={{ fontSize: 17, fontWeight: 600 }} value={b.question} maxLength={LIMITS.question}
            onChange={(e) => onChange({ question: e.target.value } as Partial<Block>)} />
        </div>
        <div className="fieldset">
          <span className="flabel">{d.choice}</span>
          {b.choices.map((c, i) => (
            <div className="choice-row" key={c.id}>
              <span className="letter" aria-hidden="true">{String.fromCharCode(65 + i)}</span>
              <input className="field" aria-label={`${d.choice} ${String.fromCharCode(65 + i)}`} value={c.text} maxLength={LIMITS.choiceText}
                onChange={(e) => setChoice(i, { text: e.target.value })} />
              <label className="check"><input type="checkbox" checked={c.correct} onChange={(e) => setChoice(i, { correct: e.target.checked })} />{d.correct}</label>
              <button type="button" className="icon-btn" aria-label={`${d.remove} ${String.fromCharCode(65 + i)}`} disabled={b.choices.length <= LIMITS.minChoices}
                onClick={() => onChange({ choices: b.choices.filter((_, j) => j !== i) } as Partial<Block>)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          ))}
          {b.choices.length < LIMITS.maxChoices && (
            <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }}
              onClick={() => onChange({ choices: [...b.choices, { id: newId(), text: "", correct: false }] } as Partial<Block>)}>{d.addChoice}</button>
          )}
        </div>
        <div className="fieldset">
          <label htmlFor={`${idBase}-r`}>{d.showResults}</label>
          <select id={`${idBase}-r`} className="field" value={b.results} onChange={(e) => onChange({ results: e.target.value as "on-reveal" | "never" } as Partial<Block>)}>
            <option value="on-reveal">{d.whenIChoose}</option>
            <option value="never">{d.never}</option>
          </select>
        </div>
      </>
    );
  }
  if (b.type === "picker") {
    return (
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="fieldset" style={{ flex: "2 1 200px" }}>
          <label htmlFor={`${idBase}-l`}>{d.label}</label>
          <input id={`${idBase}-l`} className="field" value={b.label} maxLength={LIMITS.label} onChange={(e) => onChange({ label: e.target.value } as Partial<Block>)} />
        </div>
        <div className="fieldset" style={{ flex: "1 1 200px" }}>
          <label htmlFor={`${idBase}-f`}>{d.pickFrom}</label>
          <select id={`${idBase}-f`} className="field" value={b.from} onChange={(e) => onChange({ from: e.target.value } as Partial<Block>)}>
            <option value="here">{d.pickHere}</option>
            <option value="class">{d.pickClass}</option>
          </select>
        </div>
        <div className="fieldset" style={{ flex: "1 1 200px" }}>
          <label htmlFor={`${idBase}-r`}>{d.pickRepeat}</label>
          <select id={`${idBase}-r`} className="field" value={b.repeat} onChange={(e) => onChange({ repeat: e.target.value } as Partial<Block>)}>
            <option value="turns">{d.pickTurns}</option>
            <option value="any">{d.pickAny}</option>
          </select>
        </div>
      </div>
    );
  }
  if (b.type === "noise") {
    return (
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="fieldset" style={{ flex: "2 1 200px" }}>
          <label htmlFor={`${idBase}-l`}>{d.label}</label>
          <input id={`${idBase}-l`} className="field" value={b.label} maxLength={LIMITS.label} onChange={(e) => onChange({ label: e.target.value } as Partial<Block>)} />
        </div>
        <div className="fieldset" style={{ flex: "1 1 200px" }}>
          <label htmlFor={`${idBase}-n`}>{d.noiseLimit}: {b.limit}</label>
          <input id={`${idBase}-n`} type="range" min={LIMITS.minNoise} max={LIMITS.maxNoise} value={b.limit} style={{ minHeight: 44 }}
            onChange={(e) => onChange({ limit: Number(e.target.value) } as Partial<Block>)} />
        </div>
      </div>
    );
  }
  if (b.type === "board") {
    const bad = b.url.trim() !== "" && !boardLink(b.url);
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-t`}>{d.title}</label>
          <input id={`${idBase}-t`} className="field" value={b.title} maxLength={LIMITS.title} onChange={(e) => onChange({ title: e.target.value } as Partial<Block>)} />
        </div>
        <div className="fieldset">
          <label htmlFor={`${idBase}-u`}>{d.boardLink}</label>
          <input id={`${idBase}-u`} className="field" type="url" inputMode="url" placeholder="https://draw.signify.one/embed/…" value={b.url} maxLength={600}
            aria-invalid={bad} aria-describedby={`${idBase}-uh`} onChange={(e) => onChange({ url: e.target.value } as Partial<Block>)} />
          <p id={`${idBase}-uh`} className={bad ? "notice notice-bad" : "muted"} style={{ margin: 0, fontSize: 13 }}>{bad ? d.boardBad : d.boardHint}</p>
        </div>
      </>
    );
  }
  if (b.type === "tool") {
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-t`}>{d.title}</label>
          <input id={`${idBase}-t`} className="field" value={b.title} maxLength={LIMITS.title} onChange={(e) => onChange({ title: e.target.value } as Partial<Block>)} />
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="fieldset" style={{ flex: "1 1 200px" }}>
            <label htmlFor={`${idBase}-d`}>{d.toolDisplay}</label>
            <select id={`${idBase}-d`} className="field" value={b.display} onChange={(e) => onChange({ display: e.target.value === "frame" ? "frame" : "tab" } as Partial<Block>)}>
              <option value="tab">{d.toolDisplayTab}</option>
              <option value="frame">{d.toolDisplayFrame}</option>
            </select>
          </div>
          {b.linkId && <a className="btn" href={`/lti/tool/launch?link=${b.linkId}`} target="_blank" rel="noopener">{d.toolTry} ↗</a>}
        </div>
        {!b.linkId && <p className="notice" style={{ margin: 0 }}>{d.toolNoLink}</p>}
      </>
    );
  }
  if (b.type === "link") {
    const bad = b.url.trim() !== "" && !webLink(b.url);
    return (
      <>
        <div className="fieldset">
          <label htmlFor={`${idBase}-t`}>{d.title}</label>
          <input id={`${idBase}-t`} className="field" value={b.title} maxLength={LIMITS.title} onChange={(e) => onChange({ title: e.target.value } as Partial<Block>)} />
        </div>
        <div className="fieldset">
          <label htmlFor={`${idBase}-u`}>{d.linkUrl}</label>
          <input id={`${idBase}-u`} className="field" type="url" inputMode="url" placeholder="https://…" value={b.url} maxLength={LIMITS.url}
            aria-invalid={bad} aria-describedby={`${idBase}-uh`} onChange={(e) => onChange({ url: e.target.value } as Partial<Block>)} />
          <p id={`${idBase}-uh`} className={bad ? "notice notice-bad" : "muted"} style={{ margin: 0, fontSize: 13 }}>{bad ? d.linkBad : d.linkHint}</p>
        </div>
      </>
    );
  }
  return (
    <div className="row">
      <div className="fieldset" style={{ flex: "2 1 200px" }}>
        <label htmlFor={`${idBase}-l`}>{d.label}</label>
        <input id={`${idBase}-l`} className="field" value={b.label} maxLength={LIMITS.label} onChange={(e) => onChange({ label: e.target.value } as Partial<Block>)} />
      </div>
      <div className="fieldset" style={{ flex: "1 1 100px" }}>
        <label htmlFor={`${idBase}-m`}>{d.minutes}</label>
        <input id={`${idBase}-m`} type="number" min={1} max={60} step={0.5} className="field" value={b.seconds / 60}
          onChange={(e) => onChange({ seconds: Math.round((Number(e.target.value) || 3) * 60) } as Partial<Block>)} />
      </div>
    </div>
  );
}

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,.txt,.csv,.mp3,.m4a,.mp4";
const MAX_MB = 25;

/** A file block: upload (POST /api/courses/[id]/files checks what it is), then its title and, for a picture, its description. */
function FileFields({ block: b, d, onChange, idBase, courseId }: {
  block: FileBlock; d: Dict; onChange: (p: Partial<Block>) => void; idBase: string; courseId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (file: File | undefined) => {
    if (!file || !courseId) return;
    setError("");
    if (file.size > MAX_MB * 1024 * 1024) { setError(d.fileTooBig); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/files`, {
        method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error === "type" ? d.fileRefused : body.error === "too-large" ? d.fileTooBig : body.error === "off" ? d.fileOff : d.fileFailed);
        return;
      }
      const f = body.file;
      onChange({ fileId: f.id, name: f.name, kind: f.kind, title: b.title || f.name.replace(/\.[^.]+$/, "") } as Partial<Block>);
    } catch {
      setError(d.fileFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="fieldset">
        <label htmlFor={`${idBase}-f`}>{b.fileId ? d.fileReplace : d.fileChoose}</label>
        {b.fileId && (
          <p style={{ margin: 0, fontSize: 14, overflowWrap: "anywhere" }}>
            <b>{b.name}</b> · <a href={fileUrl(b.fileId)} target="_blank" rel="noopener">{d.fileOpen} ↗</a>
          </p>
        )}
        <input id={`${idBase}-f`} className="field" type="file" accept={ACCEPT} disabled={busy || !courseId}
          aria-describedby={`${idBase}-fh`} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
        <p id={`${idBase}-fh`} className="muted" style={{ margin: 0, fontSize: 13 }}>{d.fileHint}</p>
        <p role="status" aria-live="polite" className={error ? "notice notice-bad" : "muted"} style={{ margin: 0, fontSize: 13 }}>
          {busy ? d.fileUploading : error}
        </p>
      </div>
      <div className="fieldset">
        <label htmlFor={`${idBase}-t`}>{d.title}</label>
        <input id={`${idBase}-t`} className="field" value={b.title} maxLength={LIMITS.title} onChange={(e) => onChange({ title: e.target.value } as Partial<Block>)} />
      </div>
      {b.kind === "image" && (
        <div className="fieldset">
          <label htmlFor={`${idBase}-a`}>{d.fileAlt}</label>
          <input id={`${idBase}-a`} className="field" value={b.alt} maxLength={LIMITS.alt} aria-describedby={`${idBase}-ah`}
            onChange={(e) => onChange({ alt: e.target.value } as Partial<Block>)} />
          <p id={`${idBase}-ah`} className="muted" style={{ margin: 0, fontSize: 13 }}>{d.fileAltHint}</p>
        </div>
      )}
    </>
  );
}

/**
 * "Tell the class what changed" (story 01, E2): once a lesson students can
 * already open has been changed and saved, an optional short note posted to
 * the class's Updates, with the lesson linked under it.
 */
function TellClass({ lessonId, d }: { lessonId: string; d: Dict }) {
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const post = async () => {
    setState("busy");
    const r = await fetch(`/api/lessons/${lessonId}/tell`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }),
    }).catch(() => null);
    if (r?.ok) { setNote(""); setState("done"); } else setState("failed");
  };
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <label className="label" htmlFor="tell-note">{d.tellLabel}</label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.tellHint}</p>
      <textarea id="tell-note" className="field" rows={3} maxLength={1000} value={note}
        onChange={(e) => { setNote(e.target.value); if (state !== "busy") setState("idle"); }} />
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={state === "busy"} onClick={post}>{state === "busy" ? d.asgSlidePublishing : d.tellPost}</button>
        {state === "done" && <span role="status">{d.tellDone}</span>}
        {state === "failed" && <span role="alert" className="notice" style={{ margin: 0 }}>{d.tellFailed}</span>}
      </div>
    </div>
  );
}
