"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Block, type BlockType, newBlock, newId, webLink, LIMITS } from "@/lib/blocks";
import { boardLink } from "@/lib/boards";
import type { Lesson } from "@/lib/lessons";
import type { Dict } from "@/lib/i18n";

type Status = "saved" | "dirty" | "saving" | "error" | "conflict";
type Version = { version: number; title: string; blockCount: number; savedAt: string };

const SAVE_DELAY = 800;

const SHAPE: Record<BlockType, string> = {
  text: "s-arch", poll: "s-tri", timer: "s-circle", picker: "s-square", noise: "s-square", board: "s-arch", link: "s-arch",
};
const NAME: Record<BlockType, "blockText" | "blockPoll" | "blockTimer" | "blockPicker" | "blockNoise" | "blockBoard" | "blockLink"> = {
  text: "blockText", poll: "blockPoll", timer: "blockTimer", picker: "blockPicker", noise: "blockNoise", board: "blockBoard", link: "blockLink",
};
/** The add-a-block buttons, in order: content and questions, then the Desk tools, then Boards and links. */
const ADD: BlockType[] = ["text", "poll", "timer", "picker", "noise", "board", "link"];

export default function LessonEditor({ initial, courseId, units = [], d }: {
  initial: Lesson; courseId: string; units?: { id: string; title: string }[]; d: Dict;
}) {
  const [title, setTitle] = useState(initial.title);
  const [blocks, setBlocks] = useState<Block[]>(initial.blocks);
  const [plannedFor, setPlannedFor] = useState(initial.plannedFor || "");
  const [durationMin, setDurationMin] = useState(initial.durationMin);
  const [unitId, setUnitId] = useState(initial.unitId || "");
  const [version, setVersion] = useState(initial.version);
  const [status, setStatus] = useState<Status>("saved");
  const [versions, setVersions] = useState<Version[] | null>(null);

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
                <button type="button" className="icon-btn" aria-label={d.remove} onClick={() => remove(i)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <BlockFields block={b} d={d} onChange={(p) => update(i, p)} idBase={`b${i}`} />
            </section>
          ))}

          <div className="card" style={{ padding: "14px 16px" }}>
            <p className="label">{d.addBlock}</p>
            <div className="row" style={{ marginTop: 10 }}>
              {ADD.map((type) => (
                <button key={type} type="button" className="btn" onClick={() => add(type)}><span className={`shape ${SHAPE[type]}`} />{d[NAME[type]]}</button>
              ))}
            </div>
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

function BlockFields({ block: b, d, onChange, idBase }: { block: Block; d: Dict; onChange: (p: Partial<Block>) => void; idBase: string }) {
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
