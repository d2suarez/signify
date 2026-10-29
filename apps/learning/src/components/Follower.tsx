"use client";

import { useEffect, useState } from "react";
import { type Block, blockSpeech } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { useLive, useTimerLeft } from "./useLive";
import { Stage } from "./Presenter";
import ReadAloud from "./ReadAloud";

type LiveLesson = { id: string; title: string; version: number; blocks: Block[] };

export default function Follower({ courseId, courseName, teacherName, ticket, d }: {
  courseId: string; courseName: string; teacherName?: string; ticket: string; d: Dict;
}) {
  const { state, connected, clockSkew, pickedMe, emit } = useLive(ticket);
  const [lesson, setLesson] = useState<LiveLesson | null>(null);
  const [mine, setMine] = useState<Record<string, string>>({});
  // The block this student is looking at, when the teacher lets them move.
  const [own, setOwn] = useState(0);

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

  const pace = state.pace ?? "teacher";
  const teacherIndex = state.index ?? 0;
  // Following or looking back, a move by the teacher brings everyone along.
  useEffect(() => { if (pace !== "self") setOwn(teacherIndex); }, [teacherIndex, pace]);
  const count = lesson?.blocks.length ?? 0;
  const index = pace === "teacher" ? teacherIndex
    : Math.max(0, Math.min(own, count - 1, pace === "review" ? teacherIndex : Infinity));
  // Tell the teacher where this screen is (again after a reconnect).
  useEffect(() => {
    if (connected && state.live && pace !== "teacher") emit("live:at", { index });
  }, [connected, state.live, pace, index]); // eslint-disable-line react-hooks/exhaustive-deps

  const timerLeft = useTimerLeft(state.timer, clockSkew);
  const live = lesson && state.live && lesson.id === state.lessonId;
  const block = live ? lesson.blocks[index] ?? null : null;
  // Timers, results, picks and the noise level belong to the teacher's block.
  const withTeacher = !!block && index === teacherIndex;
  const tally = withTeacher && state.revealed && state.tally && block && state.tally.blockId === block.id ? state.tally : null;
  const pickState = !withTeacher || !block || block.type !== "picker" || !state.pick ? "none"
    : pickedMe && pickedMe.blockId === block.id && pickedMe.at === state.pick.at ? "you" : "someone";

  const answer = (choiceId: string) => {
    if (!block) return;
    setMine((m) => ({ ...m, [block.id]: choiceId }));
    emit("live:answer", { blockId: block.id, choiceId });
  };

  return (
    // Text size, font, spacing and contrast come from the student's reading supports (globals.css).
    <div className="stack" style={{ fontSize: 17 }}>
      <div className="row">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22 }}>{courseName}</h1>
          {lesson && <div className="muted" style={{ fontSize: 14 }}>{lesson.title}</div>}
        </div>
        <span style={{ flex: 1 }} />
        {state.live && (
          <span className="island" style={{ padding: "8px 14px", alignItems: "center", gap: 10 }}>
            <span className="live-dot" />
            <b style={{ fontSize: 14, fontFamily: "var(--body)" }}>{pace === "self" ? d.paceSelfStudent : d.followingTeacher}{teacherName ? ` · ${teacherName}` : ""}</b>
            {state.count ? <span className="muted" style={{ fontSize: 14 }}>{index + 1} {d.of} {state.count}</span> : null}
          </span>
        )}
      </div>

      {!connected && <div className="notice" role="status">{d.connectionLost}</div>}

      {block && pace !== "teacher" && (
        <nav className="row" aria-label={d.pacing}>
          <button type="button" className="btn" onClick={() => setOwn(index - 1)} disabled={index <= 0}>← {d.back}</button>
          <button type="button" className="btn btn-primary" onClick={() => setOwn(index + 1)}
            disabled={index >= count - 1 || (pace === "review" && index >= teacherIndex)}>{d.next} →</button>
          {index !== teacherIndex && <button type="button" className="btn" onClick={() => setOwn(teacherIndex)}>{d.goToTeacher}</button>}
          <span className="muted" style={{ fontSize: 14 }}>{pace === "review" ? d.paceReviewNote : d.paceSelfNote}</span>
        </nav>
      )}

      {block && <ReadAloud text={speech(block, d, pickState, withTeacher && block.type === "noise" ? state.noise ?? null : null)} d={d} />}

      <section className="card" aria-live="polite" style={{ padding: block?.type === "poll" ? "28px 30px" : 12 }}>
        {!state.live || !block ? (
          <p className="empty" style={{ fontSize: "1.2em", padding: "40px 12px", textAlign: "center" }}>{d.waitingForTeacher}</p>
        ) : (
          <Stage block={block} tally={tally} timerLeft={withTeacher ? timerLeft : null} mine={mine[block.id] ?? null} onAnswer={block.type === "poll" ? answer : undefined} d={d}
            pickState={pickState} noise={withTeacher && block.type === "noise" ? state.noise ?? null : null} />
        )}
      </section>
    </div>
  );
}

/** What read-aloud says: the block's words, and for the Desk tools what their screen says now. */
function speech(b: Block, d: Dict, pickState: string, noise: number | null): string {
  if (b.type === "picker") {
    const now = pickState === "you" ? d.pickYou : pickState === "someone" ? d.pickSomeone : d.pickWaiting;
    return `${b.label || d.blockPicker}.\n${now}`;
  }
  // On or off only: the level changes several times a second, and new text stops the reading.
  if (b.type === "noise") return `${b.label || d.blockNoise}.\n${noise == null ? d.noiseOff : ""}`;
  return blockSpeech(b) || (b.type === "board" ? d.blockBoard : "");
}
