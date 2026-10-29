"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { type Block, blockSummary, formatSeconds } from "@/lib/blocks";
import { boardLink } from "@/lib/boards";
import type { Dict } from "@/lib/i18n";
import { noiseColour, noiseWord } from "@/lib/noise";
import { choose, turnsLeft, type Person } from "@/lib/picker";
import { useLive, useTimerLeft, type Pace } from "./useLive";
import { useNoiseMeter } from "./useNoiseMeter";

type Props = {
  lesson: { id: string; title: string; version: number; blocks: Block[] };
  courseId: string;
  courseName: string;
  ticket: string;
  /** The class from Signify ID, for name pickers set to the whole class; ok false when ID couldn't be asked. */
  roster?: { ok: boolean; students: Person[] } | null;
  d: Dict;
};

export const KIND: Record<Block["type"], string> = {
  text: "s-arch", poll: "s-tri", timer: "s-circle", picker: "s-square", noise: "s-square", board: "s-arch",
};

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Presenter({ lesson, courseId, courseName, ticket, roster, d }: Props) {
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
    emit("live:start", { count: blocks.length, version: lesson.version, blockId: blocks[0]?.id ?? null, blockIds: blocks.map((b) => b.id) });
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
  const pace: Pace = (ours && state.pace) || "teacher";
  const positions = pace === "teacher" ? {} : teacher?.positions ?? {};
  const onBlock = (i: number) => Object.values(positions).filter((p) => p === i).length;
  const tally = teacher?.tallyAll && block && teacher.tallyAll.blockId === block.id ? teacher.tallyAll : null;
  const answered = tally?.answered ?? 0;

  // ---------- name picker ----------
  const wantsClass = block?.type === "picker" && block.from === "class";
  const classFailed = wantsClass && (!roster || !roster.ok);
  const pool: Person[] = wantsClass && !classFailed ? roster!.students : students;
  const picked = teacher?.picked ?? [];
  const [rolling, setRolling] = useState<string | null>(null);
  const names = new Map([...students, ...(roster?.students ?? [])].map((p) => [p.id, p.name]));
  const lastPick = teacher?.lastPick && block && teacher.lastPick.blockId === block.id ? teacher.lastPick : null;
  const pickedName = rolling ?? (lastPick ? names.get(lastPick.studentId) ?? "?" : null);
  const pick = () => {
    if (!block || block.type !== "picker" || rolling) return;
    const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const { person, newRound } = choose(pool, picked, block.repeat, rand());
    if (!person) return;
    const send = () => {
      if (newRound) emit("live:pick-reset", { blockId: block.id });
      emit("live:pick", { blockId: block.id, studentId: person.id });
      setRolling(null);
    };
    if (reducedMotion() || pool.length < 2) { send(); return; }
    // A short shuffle of names on the board first, as on Teacher's Desk.
    let n = 0;
    const roll = () => {
      setRolling(pool[Math.floor(rand() * pool.length)].name);
      if (++n < 14) setTimeout(roll, 70 + n * 6); else send();
    };
    roll();
  };

  // ---------- noise meter ----------
  const noise = useNoiseMeter((level) => emit("live:noise", { level }));
  const stopNoise = noise.stop;
  // Leaving the block turns the microphone off.
  useEffect(() => { stopNoise(); }, [block?.id, stopNoise]);

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
            {block
              ? <Stage block={block} teacherView tally={tally} timerLeft={timerLeft} d={d}
                  pickName={pickedName} rolling={!!rolling} turnsLeft={block.type === "picker" && block.repeat === "turns" ? turnsLeft(pool, picked) : null}
                  noise={noise.listening ? noise.level : null} />
              : <div className="stage"><h1>{d.emptyLesson}</h1></div>}
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
                  ? <button type="button" className="btn" onClick={() => emit("live:timer", { action: "pause", remaining: timerLeft })}>{d.pause}</button>
                  : <button type="button" className="btn btn-primary" onClick={() => emit("live:timer", { action: "run", remaining: timerLeft ?? block.seconds })}>{d.start}</button>}
                <button type="button" className="btn" onClick={() => emit("live:timer", { action: "reset" })}>{d.reset}</button>
              </>
            )}
            {block?.type === "picker" && (
              <>
                <button type="button" className="btn btn-primary" disabled={!pool.length || !!rolling} onClick={pick}>{d.pickName}</button>
                {block.repeat === "turns" && picked.length > 0 && (
                  <button type="button" className="btn" onClick={() => emit("live:pick-reset", { blockId: block.id })}>{d.pickReset}</button>
                )}
              </>
            )}
            {block?.type === "noise" && (
              <button type="button" className="btn btn-primary" aria-pressed={noise.listening} onClick={() => (noise.listening ? noise.stop() : noise.start())}>
                {noise.listening ? d.micOff : d.micOn}
              </button>
            )}
          </div>
          <fieldset className="choice pace" disabled={!ours}>
            <legend>{d.pacing}</legend>
            <div className="choice-opts">
              {([["teacher", d.paceTeacher], ["review", d.paceReview], ["self", d.paceSelf]] as const).map(([v, text]) => (
                <label key={v}>
                  <input type="radio" name="pace" value={v} checked={pace === v} onChange={() => emit("live:pace", { pace: v })} />
                  <span>{text}</span>
                </label>
              ))}
            </div>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
              {pace === "teacher" ? d.paceTeacherHint : pace === "review" ? d.paceReviewHint : d.paceSelfHint}
            </p>
          </fieldset>
          {block?.type === "picker" && classFailed && <p className="notice" role="status" style={{ margin: 0 }}>{d.rosterFallback}</p>}
          {block?.type === "picker" && !pool.length && <p className="muted" style={{ margin: 0 }}>{d.pickNobody}</p>}
          {block?.type === "noise" && (
            <p className={noise.error ? "notice" : "muted"} role="status" style={{ margin: 0 }}>
              {noise.error === "blocked" ? d.micBlocked : noise.error === "missing" ? d.micMissing : noise.listening ? d.micHintOn : d.micHintOff}
            </p>
          )}

          <div className="card" style={{ padding: "14px 16px" }}>
            <nav className="strip" aria-label={lesson.title}>
              {blocks.map((b, i) => (
                <button key={b.id} type="button" aria-current={i === index} onClick={() => go(i)}>
                  <small><span className={`shape ${KIND[b.type]}`} style={{ width: 8, height: 8, marginRight: 4 }} />{i + 1}</small>
                  <b>{blockSummary(b) || "—"}</b>
                  {pace !== "teacher" && onBlock(i) > 0 && <span className="strip-count" aria-label={`${onBlock(i)} ${d.studentsHere}`}>{onBlock(i)}</span>}
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
                    {pace !== "teacher" && positions[s.id] !== undefined && (
                      <span className="pill" title={d.slide}>{d.slide} {positions[s.id] + 1}</span>
                    )}
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

export function Stage({ block, teacherView, tally, timerLeft, mine, onAnswer, d, pickName, rolling, turnsLeft: left, pickState, noise }: {
  block: Block;
  teacherView?: boolean;
  tally?: { counts: Record<string, number>; answered: number } | null;
  timerLeft?: number | null;
  mine?: string | null;
  onAnswer?: (choiceId: string) => void;
  d: Dict;
  /** Picker, teacher's screen: the name picked (or flashing past while it shuffles). */
  pickName?: string | null;
  rolling?: boolean;
  turnsLeft?: number | null;
  /** Picker, student's screen: nothing yet, someone else, or them. */
  pickState?: "none" | "someone" | "you";
  /** Noise meter: the level 0-100, or null while the microphone is off. */
  noise?: number | null;
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
  if (block.type === "picker") {
    const big = teacherView
      ? pickName ?? d.pickStart
      : pickState === "you" ? d.pickYou : pickState === "someone" ? d.pickSomeone : d.pickWaiting;
    return (
      <div className="stage stage-center" style={{ background: "var(--p2)" }}>
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          <span className="shape s-square" style={{ background: "#fff" }} />
          <span className="stage-kicker">{block.label || d.blockPicker}</span>
        </div>
        <div className={`pick-face${rolling ? " is-rolling" : ""}${pickState === "you" ? " is-you" : ""}`} aria-live={rolling ? "off" : "polite"}>{big}</div>
        {teacherView && left != null && <p className="stage-foot">{left} {d.pickTurnsLeft}</p>}
      </div>
    );
  }
  if (block.type === "noise") {
    const on = noise != null;
    const c = on ? noiseColour(noise, block.limit) : { background: "var(--p2)", ink: "#fff" };
    const word = on ? d[noiseWord(noise)] : d.noiseOff;
    return (
      <div className="stage stage-center" style={{ background: c.background, color: c.ink }}>
        <span className="stage-kicker">{block.label || d.blockNoise}</span>
        <div className="noise-word" aria-live="off">{word}</div>
        <div className="noise-track" role="meter" aria-label={d.blockNoise} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={on ? Math.round(noise) : 0} aria-valuetext={word}>
          <i style={{ width: `${on ? noise : 0}%` }} />
          <b style={{ left: `${block.limit}%` }} title={d.noiseLimit} />
        </div>
      </div>
    );
  }
  if (block.type === "board") {
    const link = boardLink(block.url);
    const title = block.title || d.blockBoard;
    if (!link) return <div className="stage" style={{ background: "var(--p4)" }}><h1>{title}</h1><p className="body">{d.boardEmpty}</p></div>;
    return (
      <div className="stack" style={{ gap: 10 }}>
        {link.embed ? (
          <div className="stage stage-board">
            {/* Boards' public, read-only live view of a board shared to the web. Scripts
                and its own origin so it can load and follow the board; no top navigation. */}
            <iframe src={link.url} title={title} loading="lazy" referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
          </div>
        ) : (
          <div className="stage" style={{ background: "var(--p4)" }}>
            <h1>{title}</h1>
            <p className="body">{d.boardOpenOnly}</p>
          </div>
        )}
        <div className="row">
          {link.embed && <b style={{ minWidth: 0 }}>{title}</b>}
          <span style={{ flex: 1 }} />
          <a className="btn btn-sm" href={link.url} target="_blank" rel="noopener noreferrer">{d.openBoard} ↗</a>
        </div>
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
          <legend className="label" style={{ marginBottom: 10 }}>{d.chooseOne}</legend>
          {block.choices.map((c, i) => (
            <button key={c.id} type="button" className="answer" aria-pressed={mine === c.id} onClick={() => onAnswer(c.id)}>
              <span className="letter">{String.fromCharCode(65 + i)}</span>
              <span style={{ flex: 1 }}>{c.text}</span>
              {tally && <span style={{ fontSize: 14 }}>{tally.counts[c.id] || 0}</span>}
            </button>
          ))}
        </fieldset>
        {mine && <p className="muted" style={{ margin: 0 }}>{d.answerSent}</p>}
      </div>
    );
  }
  return (
    <div className="stage">
      <div className="row" style={{ gap: 8 }}>
        <span className="shape s-tri" />
        <span className="stage-kicker">{d.blockPoll}</span>
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
