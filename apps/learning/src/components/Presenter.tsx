"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { type Block, blockSummary, formatSeconds } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { useLive, useTimerLeft } from "./useLive";

type Props = {
  lesson: { id: string; title: string; version: number; blocks: Block[] };
  courseId: string;
  courseName: string;
  ticket: string;
  d: Dict;
};

const KIND: Record<Block["type"], string> = { text: "s-arch", poll: "s-tri", timer: "s-circle" };

export default function Presenter({ lesson, courseId, courseName, ticket, d }: Props) {
  const { state, teacher, connected, clockSkew, emit } = useLive(ticket);
  const blocks = lesson.blocks;
  const started = useRef(false);

  // On every (re)connect, (re)start this lesson. The server keeps the
  // current slide if this lesson was already live, so a teacher whose laptop
  // dropped Wi-Fi comes back where they were.
  useEffect(() => {
    if (!connected) { started.current = false; return; }
    if (started.current) return;
    started.current = true;
    emit("live:start", { count: blocks.length, version: lesson.version, blockId: blocks[0]?.id ?? null });
  }, [connected, blocks, lesson.version, emit]);

  const ours = state.live && state.lessonId === lesson.id;
  const index = ours ? state.index ?? 0 : 0;
  const block = blocks[index];
  const go = (i: number) => {
    if (i < 0 || i >= blocks.length) return;
    emit("live:goto", { index: i, blockId: blocks[i].id });
  };

  // Arrow keys and space move the lesson, as in any slide deck — unless the
  // teacher is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(index + 1); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(index - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const timerLeft = useTimerLeft(ours ? state.timer : null, clockSkew);
  const students = teacher?.students ?? [];
  const tally = teacher?.tallyAll && block && teacher.tallyAll.blockId === block.id ? teacher.tallyAll : null;
  const answered = tally?.answered ?? 0;

  return (
    <div className="stack">
      <div className="row">
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 13 }}>{courseName}</div>
          <h1 style={{ fontSize: 24 }}>{lesson.title}</h1>
        </div>
        <span style={{ flex: 1 }} />
        <div className="island" aria-label="Live status">
          <div className="chip">{connected ? <span className="live-dot" style={{ alignSelf: "center" }} /> : null}<b>{students.length}</b><span>{d.studentsNow}</span></div>
          <div className="chip"><b>{blocks.length ? index + 1 : 0}</b><span>{d.of} {blocks.length}</span></div>
          {block?.type === "poll" && <div className="chip"><b>{answered}</b><span>{d.answered}</span></div>}
        </div>
        <Link className="btn btn-dark" href={`/courses/${courseId}`} onClick={() => emit("live:end")}>{d.endLesson}</Link>
      </div>

      {!connected && <div className="notice" role="status">{d.connectionLost}</div>}

      <div className="editor">
        <section className="editor-main">
          <div className="card" style={{ padding: 12 }}>
            {block ? <Stage block={block} teacherView tally={tally} timerLeft={timerLeft} /> : <div className="stage"><h1>{d.emptyLesson}</h1></div>}
          </div>

          <div className="row">
            <button type="button" className="btn" onClick={() => go(index - 1)} disabled={index <= 0}>← {d.back}</button>
            <button type="button" className="btn btn-primary" onClick={() => go(index + 1)} disabled={index >= blocks.length - 1}>{d.next} →</button>
            <span style={{ flex: 1 }} />
            {block?.type === "poll" && block.results !== "never" && (
              <button type="button" className="btn" aria-pressed={!!state.revealed} onClick={() => emit("live:reveal", { revealed: !state.revealed })}>
                {state.revealed ? d.hideResults : d.showToClass}
              </button>
            )}
            {block?.type === "timer" && (
              <>
                {state.timer?.endsAt
                  ? <button type="button" className="btn" onClick={() => emit("live:timer", { action: "pause", remaining: timerLeft })}>Pause</button>
                  : <button type="button" className="btn btn-primary" onClick={() => emit("live:timer", { action: "run", remaining: timerLeft ?? block.seconds })}>Start</button>}
                <button type="button" className="btn" onClick={() => emit("live:timer", { action: "reset" })}>Reset</button>
              </>
            )}
          </div>

          <div className="card" style={{ padding: "14px 16px" }}>
            <nav className="strip" aria-label={lesson.title}>
              {blocks.map((b, i) => (
                <button key={b.id} type="button" aria-current={i === index} onClick={() => go(i)}>
                  <small><span className={`shape ${KIND[b.type]}`} style={{ width: 8, height: 8, marginRight: 4 }} />{i + 1}</small>
                  <b>{blockSummary(b) || "—"}</b>
                </button>
              ))}
            </nav>
          </div>
        </section>

        <aside className="editor-side">
          <div className="card">
            <p className="label">{students.length} {d.studentsNow}</p>
            <ul className="list" style={{ marginTop: 8 }}>
              {students.map((s) => {
                const choice = teacher?.answers?.[s.id];
                const letter = block?.type === "poll" && choice ? block.choices.findIndex((c) => c.id === choice) : -1;
                return (
                  <li key={s.id} style={{ padding: "8px 0" }}>
                    <span className="grow" style={{ minWidth: 0 }}>{s.name}</span>
                    {letter >= 0 && <span className="pill">{String.fromCharCode(65 + letter)}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function Stage({ block, teacherView, tally, timerLeft, mine, onAnswer, d }: {
  block: Block;
  teacherView?: boolean;
  tally?: { counts: Record<string, number>; answered: number } | null;
  timerLeft?: number | null;
  mine?: string | null;
  onAnswer?: (choiceId: string) => void;
  d?: Dict;
}) {
  if (block.type === "text") {
    return (
      <div className="stage" style={{ background: "var(--p4)" }}>
        {block.title && <h1>{block.title}</h1>}
        {block.body && <div className="body">{block.body}</div>}
      </div>
    );
  }
  if (block.type === "timer") {
    const left = timerLeft ?? block.seconds;
    return (
      <div className="stage" style={{ background: "var(--p1)", alignItems: "center", textAlign: "center" }}>
        {block.label && <h1 style={{ maxWidth: "none" }}>{block.label}</h1>}
        <div className="timer-face" role="timer" aria-live="off">{formatSeconds(left)}</div>
      </div>
    );
  }
  // Poll
  const total = tally ? Math.max(1, tally.answered) : 1;
  if (onAnswer) {
    return (
      <div className="stack">
        <h1 style={{ fontSize: "clamp(22px, 3vw, 34px)", maxWidth: "30ch" }}>{block.question}</h1>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <legend className="label" style={{ marginBottom: 10 }}>{d?.chooseOne}</legend>
          {block.choices.map((c, i) => (
            <button key={c.id} type="button" className="answer" aria-pressed={mine === c.id} onClick={() => onAnswer(c.id)}>
              <span className="letter">{String.fromCharCode(65 + i)}</span>
              <span style={{ flex: 1 }}>{c.text}</span>
              {tally && <span style={{ fontSize: 14 }}>{tally.counts[c.id] || 0}</span>}
            </button>
          ))}
        </fieldset>
        {mine && <p className="muted" style={{ margin: 0 }}>{d?.answerSent}</p>}
      </div>
    );
  }
  return (
    <div className="stage">
      <div className="row" style={{ gap: 8 }}>
        <span className="shape s-tri" />
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>Poll</span>
      </div>
      <h1>{block.question}</h1>
      <div className="stage-choices">
        {block.choices.map((c, i) => {
          const n = tally?.counts[c.id] || 0;
          return (
            <div key={c.id} className={`stage-choice${teacherView && c.correct ? " correct" : ""}`}>
              {String.fromCharCode(65 + i)} · {c.text}
              {tally && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>{n} · {Math.round((n / total) * 100)}%</div>
                  <div className="bar"><i style={{ width: `${(n / total) * 100}%` }} /></div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
