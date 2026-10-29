"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Block } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { useLive, useTimerLeft } from "./useLive";
import { Stage } from "./Presenter";

/**
 * What the class sees on the big screen: the teacher's current slide, poll
 * results only once shown to the class, the timer, a picked name and the
 * noise level. No answers by name, no controls. It only listens: the
 * presenter's screen moves the lesson.
 */
export default function Projector({ lesson, courseId, ticket, roster, d }: {
  lesson: { id: string; title: string; version: number; blocks: Block[] };
  courseId: string; ticket: string; roster: { id: string; name: string }[]; d: Dict;
}) {
  const router = useRouter();
  const { state, teacher, connected, clockSkew } = useLive(ticket);
  const [full, setFull] = useState(false);

  const ours = state.live && state.lessonId === lesson.id;
  // The teacher saved the lesson while presenting: load the new version.
  useEffect(() => {
    if (ours && state.lessonVersion && state.lessonVersion !== lesson.version) router.refresh();
  }, [ours, state.lessonVersion, lesson.version, router]);

  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const block = ours ? lesson.blocks[state.index ?? 0] ?? null : null;
  const timerLeft = useTimerLeft(ours ? state.timer : null, clockSkew);
  const tally = block && state.revealed && state.tally && state.tally.blockId === block.id ? state.tally : null;
  const names = new Map([...(teacher?.students ?? []), ...roster].map((p) => [p.id, p.name]));
  const lastPick = teacher?.lastPick && block && teacher.lastPick.blockId === block.id ? teacher.lastPick : null;

  return (
    <main className="projector" aria-label={lesson.title}>
      {!full && (
        <div className="projector-bar">
          <span className="grow">{lesson.title}</span>
          {!connected && <span role="status">{d.connectionLost}</span>}
          <button type="button" className="btn btn-sm" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>{d.fullScreen}</button>
          <a className="btn btn-sm" href={`/courses/${courseId}`}>{d.close}</a>
        </div>
      )}
      <div className="projector-stage">
        {block
          ? <Stage block={block} teacherView tally={tally} timerLeft={timerLeft} d={d}
              pickName={lastPick ? names.get(lastPick.studentId) ?? null : null}
              noise={block.type === "noise" ? state.noise ?? null : null} />
          : <div className="stage stage-center"><h1>{ours ? d.emptyLesson : d.projectorWaiting}</h1></div>}
      </div>
    </main>
  );
}
