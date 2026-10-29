"use client";

import { useEffect, useState } from "react";
import type { Block } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { useLive, useTimerLeft } from "./useLive";
import { Stage } from "./Presenter";

type LiveLesson = { id: string; title: string; version: number; blocks: Block[] };

const SIZES = [15, 17, 20, 24];

export default function Follower({ courseId, courseName, teacherName, ticket, d }: {
  courseId: string; courseName: string; teacherName?: string; ticket: string; d: Dict;
}) {
  const { state, connected, clockSkew, emit } = useLive(ticket);
  const [lesson, setLesson] = useState<LiveLesson | null>(null);
  const [mine, setMine] = useState<Record<string, string>>({});
  const [size, setSize] = useState(1);

  // Fetch the lesson whenever a different one (or a newer save of it) goes live.
  useEffect(() => {
    if (!state.live || !state.lessonId) { setLesson(null); return; }
    if (lesson && lesson.id === state.lessonId && lesson.version === state.lessonVersion) return;
    let gone = false;
    fetch(`/api/courses/${courseId}/live-lesson`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!gone && body?.live) setLesson(body.lesson); });
    return () => { gone = true; };
  }, [state.live, state.lessonId, state.lessonVersion, courseId, lesson]);

  const timerLeft = useTimerLeft(state.timer, clockSkew);
  const block = lesson && state.live && lesson.id === state.lessonId ? lesson.blocks[state.index ?? 0] : null;
  const tally = state.revealed && state.tally && block && state.tally.blockId === block.id ? state.tally : null;

  const answer = (choiceId: string) => {
    if (!block) return;
    setMine((m) => ({ ...m, [block.id]: choiceId }));
    emit("live:answer", { blockId: block.id, choiceId });
  };

  return (
    <div className="stack" style={{ fontSize: SIZES[size] }}>
      <div className="row">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22 }}>{courseName}</h1>
          {lesson && <div className="muted" style={{ fontSize: 14 }}>{lesson.title}</div>}
        </div>
        <span style={{ flex: 1 }} />
        {state.live && (
          <span className="island" style={{ padding: "8px 14px", alignItems: "center", gap: 10 }}>
            <span className="live-dot" />
            <b style={{ fontSize: 14, fontFamily: "var(--body)" }}>{d.followingTeacher}{teacherName ? ` · ${teacherName}` : ""}</b>
            {state.count ? <span className="muted" style={{ fontSize: 14 }}>{(state.index ?? 0) + 1} {d.of} {state.count}</span> : null}
          </span>
        )}
        <span className="seg" role="group" aria-label="Text size">
          <button type="button" aria-label="Smaller text" onClick={() => setSize((s) => Math.max(0, s - 1))}>A−</button>
          <button type="button" aria-label="Larger text" onClick={() => setSize((s) => Math.min(SIZES.length - 1, s + 1))}>A+</button>
        </span>
      </div>

      {!connected && <div className="notice" role="status">{d.connectionLost}</div>}

      <section className="card" aria-live="polite" style={{ padding: block?.type === "poll" ? "28px 30px" : 12 }}>
        {!state.live || !block ? (
          <p className="empty" style={{ fontSize: "1.2em", padding: "40px 12px", textAlign: "center" }}>{d.waitingForTeacher}</p>
        ) : (
          <Stage block={block} tally={tally} timerLeft={timerLeft} mine={mine[block.id] ?? null} onAnswer={block.type === "poll" ? answer : undefined} d={d} />
        )}
      </section>
    </div>
  );
}
