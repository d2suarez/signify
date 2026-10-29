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
  const pickState = !block || block.type !== "picker" || !state.pick ? "none"
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
            <b style={{ fontSize: 14, fontFamily: "var(--body)" }}>{d.followingTeacher}{teacherName ? ` · ${teacherName}` : ""}</b>
            {state.count ? <span className="muted" style={{ fontSize: 14 }}>{(state.index ?? 0) + 1} {d.of} {state.count}</span> : null}
          </span>
        )}
      </div>

      {!connected && <div className="notice" role="status">{d.connectionLost}</div>}

      {block && <ReadAloud text={speech(block, d, pickState, block.type === "noise" ? state.noise ?? null : null)} d={d} />}

      <section className="card" aria-live="polite" style={{ padding: block?.type === "poll" ? "28px 30px" : 12 }}>
        {!state.live || !block ? (
          <p className="empty" style={{ fontSize: "1.2em", padding: "40px 12px", textAlign: "center" }}>{d.waitingForTeacher}</p>
        ) : (
          <Stage block={block} tally={tally} timerLeft={timerLeft} mine={mine[block.id] ?? null} onAnswer={block.type === "poll" ? answer : undefined} d={d}
            pickState={pickState} noise={block.type === "noise" ? state.noise ?? null : null} />
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
