"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { Response, Responses, StudentItem } from "@/lib/quiz";
import type { StudentQuizView } from "@/lib/quiz-store";
import ReadAloud from "./ReadAloud";

type Status = "saved" | "dirty" | "saving" | "error" | "conflict";
const SAVE_DELAY = 1200;

/**
 * A student taking a quiz: start, answer (autosaved, version-checked), hand
 * in. The time limit is the server's; the countdown here only shows it. When
 * it runs out the answers saved so far are handed in.
 *
 * Facts the teacher sees, and the student is told about: when this page was
 * left and come back to, and what was pasted into written answers. Nothing
 * else, and never a verdict.
 */
export default function QuizTaker({ assignmentId, initial, points, d }: {
  assignmentId: string; initial: StudentQuizView; points: number; d: Dict;
}) {
  const [view, setView] = useState(initial);
  const open = view.open;
  const [responses, setResponses] = useState<Responses>(open?.responses ?? {});
  const [status, setStatus] = useState<Status>("saved");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const latest = useRef({ responses, version: open?.version ?? 0, id: open?.id ?? "" });
  latest.current.responses = responses;
  const events = useRef<{ kind: "left" | "back"; at: number }[]>([]);
  const pastes = useRef<{ item: string; at: number; chars: number; text: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const again = useRef(false);
  const stopped = useRef(false);
  // Server time minus this browser's, so the countdown follows the server.
  const offset = useRef(Date.parse(initial.now) - Date.now());

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/assignments/${assignmentId}/quiz`, { cache: "no-store" });
    if (!res.ok) return;
    const next: StudentQuizView = (await res.json()).view;
    offset.current = Date.parse(next.now) - Date.now();
    setView(next);
    setResponses(next.open?.responses ?? {});
    latest.current = { responses: next.open?.responses ?? {}, version: next.open?.version ?? 0, id: next.open?.id ?? "" };
    stopped.current = false;
    setStatus("saved");
  }, [assignmentId]);

  const send = useCallback(async (handIn = false): Promise<boolean> => {
    if (stopped.current || !latest.current.id) return false;
    if (inFlight.current) {
      if (!handIn) { again.current = true; return inFlight.current; }
      await inFlight.current;
      if (stopped.current) return false;
    }
    const run = (async () => {
      setStatus("saving");
      const s = latest.current;
      const ev = events.current, ps = pastes.current;
      const now = Date.now();
      try {
        const res = await fetch(`/api/assignments/${assignmentId}/quiz`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attemptId: s.id, baseVersion: s.version, responses: s.responses, handIn,
            events: ev.map((e) => ({ kind: e.kind, ago: now - e.at })),
            pastes: ps.map((p) => ({ item: p.item, ago: now - p.at, chars: p.chars, text: p.text })),
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.status === 409 && out.error === "conflict") { stopped.current = true; setStatus("conflict"); return false; }
        if (res.status === 409 && (out.error === "time-up" || out.error === "handed-in")) {
          stopped.current = true;
          setNote(out.error === "time-up" ? d.quizTimeUpNote : "");
          await refresh();
          return false;
        }
        if (!res.ok) throw new Error(String(res.status));
        events.current = events.current.filter((e) => !ev.includes(e));
        pastes.current = pastes.current.filter((p) => !ps.includes(p));
        latest.current.version = out.attempt.version;
        setStatus(again.current ? "dirty" : "saved");
        if (handIn) await refresh();
        return true;
      } catch {
        setStatus("error");
        if (!handIn) timer.current = setTimeout(() => send(), 4000);
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    inFlight.current = null;
    if (again.current && !handIn) { again.current = false; return send(); }
    return ok;
  }, [assignmentId, d, refresh]);

  const later = useCallback(() => {
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => send(), SAVE_DELAY);
  }, [send]);

  const answer = (id: string, r: Response | null) => {
    if (stopped.current) return;
    setResponses((cur) => {
      const next = { ...cur };
      if (r === null || (Array.isArray(r) && !r.length) || (typeof r === "string" && !r)) delete next[id]; else next[id] = r;
      latest.current.responses = next;
      return next;
    });
    later();
  };

  // Leaving the page and coming back: facts for the teacher, sent with the next save.
  useEffect(() => {
    if (!open) return;
    const onVis = () => {
      events.current.push({ kind: document.hidden ? "left" : "back", at: Date.now() });
      if (!document.hidden) later();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [open, later]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (open && (status === "dirty" || status === "saving" || status === "error")) e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status, open]);

  // The countdown (shown), and the hand-in when it reaches zero.
  const deadline = open?.deadlineAt ? Date.parse(open.deadlineAt) : null;
  const [left, setLeft] = useState<number | null>(null);
  const [warn, setWarn] = useState("");
  useEffect(() => {
    if (!deadline) { setLeft(null); return; }
    let warned5 = false, warned1 = false, ended = false;
    const tick = () => {
      const ms = deadline - (Date.now() + offset.current);
      setLeft(Math.max(0, ms));
      if (ms <= 5 * 60_000 && ms > 60_000 && !warned5) { warned5 = true; setWarn(d.quizFiveMinutes); }
      if (ms <= 60_000 && ms > 0 && !warned1) { warned1 = true; setWarn(d.quizOneMinute); }
      if (ms <= 0 && !ended) { ended = true; setNote(d.quizTimeUpNote); send(true); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, d, send]);

  const start = async () => {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/quiz`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setNote(out.error === "no-attempts" ? d.quizNoAttemptsLeft : d.saveError); return; }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handIn = async () => {
    const unanswered = (open?.items ?? []).filter((i) => responses[i.identifier] === undefined).length;
    if (!confirm(unanswered ? `${d.quizHandInConfirm} ${d.quizUnanswered}: ${unanswered}.` : d.quizHandInConfirm)) return;
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    try { await send(true); } finally { setBusy(false); }
  };

  const mmss = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(sec).padStart(2, "0")}`;
  };
  const stateText = { saved: latest.current.version > 1 ? d.saved : "", dirty: d.unsaved, saving: d.saving, error: d.saveFailed, conflict: "" }[status];
  const left_ = view.allowed ? view.allowed - view.used : null;

  if (!open) {
    return (
      <div className="stack">
        {view.attempts.length > 0 && <Results view={view} points={points} d={d} />}
        <section className="card stack" style={{ gap: 10 }} aria-labelledby="quiz-start">
          <h2 id="quiz-start" style={{ fontSize: 22 }}>{view.attempts.length ? d.quizTryAgain : d.quizReady}</h2>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>{view.minutes ? `${d.quizTimeLimit}: ${view.minutes} ${d.quizMinutes}. ${d.quizClockNote}` : d.quizNoTimeLimit}</li>
            <li>{view.allowed ? `${d.quizAttempts}: ${view.used} ${d.of} ${view.allowed}` : d.quizUnlimitedAttempts}</li>
          </ul>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizFactsNote}</p>
          {note && <p className="notice" role="alert">{note}</p>}
          {left_ === 0
            ? <p className="notice">{d.quizNoAttemptsLeft}</p>
            : <div><button type="button" className="btn btn-primary" disabled={busy} onClick={start}>{view.attempts.length ? `${d.quizStartAttempt} ${view.used + 1}` : d.quizStart}</button></div>}
        </section>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="quiz-bar card row" role="group" aria-label={d.quizWord}>
        <span className="grow"><b>{d.quizAttempt} {open.number}</b>{view.allowed ? ` ${d.of} ${view.allowed}` : ""}</span>
        <span className="save-state" role="status" aria-live="polite">{stateText}</span>
        {left !== null && (
          <span className={`quiz-clock${left < 60_000 ? " quiz-clock-low" : ""}`}>
            <span className="sr-only">{d.quizTimeLeft}: </span><span role="timer" aria-live="off">{mmss(left)}</span>
          </span>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="assertive">{warn}</p>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizFactsNote}</p>
      {status === "conflict" && (
        <div className="notice notice-bad" role="alert">{d.quizConflict} <button className="btn btn-sm" type="button" onClick={() => refresh()}>{d.reload}</button></div>
      )}
      {note && <p className="notice" role="alert">{note}</p>}

      <ol className="quiz-items">
        {open.items.map((it, k) => (
          <li key={it.identifier} className="card">
            <Question item={it} n={k + 1} value={responses[it.identifier] ?? null} d={d}
              onAnswer={(r) => answer(it.identifier, r)}
              onPaste={(chars, text) => pastes.current.push({ item: it.identifier, at: Date.now(), chars, text: text.slice(0, 5000) })} />
          </li>
        ))}
      </ol>

      <div className="row">
        <span className="muted grow">{Object.keys(responses).length} {d.of} {open.items.length} {d.quizAnswered}</span>
        <button type="button" className="btn btn-primary" disabled={busy || status === "conflict"} onClick={handIn}>{d.quizHandIn}</button>
      </div>
    </div>
  );
}

function Question({ item: it, n, value, onAnswer, onPaste, d }: {
  item: StudentItem; n: number; value: Response | null; d: Dict;
  onAnswer: (r: Response | null) => void; onPaste: (chars: number, text: string) => void;
}) {
  const name = `q-${it.identifier}`;
  const speech = [it.prompt, ...(it.kind === "match" ? [] : it.choices.map((c, k) => `${String.fromCharCode(65 + k)}. ${c.text}`))].join("\n");
  const head = (
    <>
      <legend className="quiz-q">
        <span className="label">{d.quizQuestion} {n} · {it.points} {d.pts}</span>
        <span className="quiz-prompt">{it.prompt || <span className="muted">—</span>}</span>
      </legend>
      <ReadAloud text={speech} d={d} />
    </>
  );

  if (it.kind === "single" || it.kind === "truefalse" || it.kind === "multiple") {
    const multi = it.kind === "multiple";
    const picked = multi ? (Array.isArray(value) ? value : []) : value;
    return (
      <fieldset className="quiz-fieldset">
        {head}
        {multi && <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>{d.quizPickAll}</p>}
        <div className="quiz-choices">
          {it.choices.map((c, k) => {
            const on = multi ? (picked as string[]).includes(c.identifier) : picked === c.identifier;
            return (
              <label key={c.identifier} className={`quiz-choice${on ? " is-on" : ""}`}>
                <input type={multi ? "checkbox" : "radio"} name={name} checked={on}
                  onChange={(e) => {
                    if (!multi) return onAnswer(c.identifier);
                    const cur = picked as string[];
                    onAnswer(e.target.checked ? [...cur, c.identifier] : cur.filter((x) => x !== c.identifier));
                  }} />
                {it.kind !== "truefalse" && <span className="quiz-letter" aria-hidden>{String.fromCharCode(65 + k)}</span>}
                <span>{c.text}</span>
              </label>
            );
          })}
        </div>
        {!multi && value !== null && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => onAnswer(null)}>{d.quizClear}</button>}
      </fieldset>
    );
  }

  if (it.kind === "short" || it.kind === "numeric") {
    return (
      <fieldset className="quiz-fieldset">
        {head}
        <label htmlFor={name} className="sr-only">{d.quizYourAnswer}</label>
        <input id={name} className="field" style={{ maxWidth: 420 }} value={typeof value === "string" ? value : ""} maxLength={500}
          inputMode={it.kind === "numeric" ? "decimal" : undefined} autoComplete="off" spellCheck={it.kind === "short"}
          placeholder={d.quizYourAnswer} onChange={(e) => onAnswer(e.target.value)} />
      </fieldset>
    );
  }

  if (it.kind === "essay") {
    const text = typeof value === "string" ? value : "";
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return (
      <fieldset className="quiz-fieldset">
        {head}
        <label htmlFor={name} className="sr-only">{d.quizYourAnswer}</label>
        <textarea id={name} className="field writing" rows={10} value={text} maxLength={20000} spellCheck
          onChange={(e) => onAnswer(e.target.value)}
          onPaste={(e) => { const t = e.clipboardData.getData("text/plain"); if (t) onPaste(t.length, t); }} />
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted grow" style={{ fontSize: 13 }}>{words} {d.quizWords}</span>
          <ReadAloud text={text} d={d} label={d.readMyWriting} />
        </div>
      </fieldset>
    );
  }

  if (it.kind === "match") {
    const cur = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <fieldset className="quiz-fieldset">
        {head}
        <div className="stack" style={{ gap: 8 }}>
          {it.choices.map((c) => (
            <div key={c.identifier} className="row quiz-match">
              <label htmlFor={`${name}-${c.identifier}`} className="grow">{c.text}</label>
              <select id={`${name}-${c.identifier}`} className="field" style={{ width: "auto", minWidth: 200, maxWidth: "100%" }}
                value={cur[c.identifier] ?? ""}
                onChange={(e) => {
                  const next = { ...cur };
                  if (e.target.value) next[c.identifier] = e.target.value; else delete next[c.identifier];
                  onAnswer(Object.keys(next).length ? next : null);
                }}>
                <option value="">{d.quizChoose}</option>
                {it.targets.map((t) => <option key={t.identifier} value={t.identifier}>{t.text}</option>)}
              </select>
            </div>
          ))}
        </div>
      </fieldset>
    );
  }

  // Ordering: buttons, not dragging, so it works with a keyboard and a screen reader.
  const order = Array.isArray(value) && value.length === it.choices.length ? value : it.choices.map((c) => c.identifier);
  const text = (id: string) => it.choices.find((c) => c.identifier === id)?.text ?? "";
  const move = (k: number, dir: -1 | 1) => {
    const j = k + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[k], next[j]] = [next[j], next[k]];
    onAnswer(next);
  };
  return (
    <fieldset className="quiz-fieldset">
      {head}
      <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>{d.quizOrderHint}</p>
      <ol className="quiz-order">
        {order.map((id, k) => (
          <li key={id} className="row">
            <span className="grow">{text(id)}</span>
            <button type="button" className="btn btn-sm" disabled={k === 0} onClick={() => move(k, -1)} aria-label={`${d.moveUp}: ${text(id)}`}>↑</button>
            <button type="button" className="btn btn-sm" disabled={k === order.length - 1} onClick={() => move(k, 1)} aria-label={`${d.moveDown}: ${text(id)}`}>↓</button>
          </li>
        ))}
      </ol>
      {!Array.isArray(value) && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.quizOrderUntouched}</p>}
    </fieldset>
  );
}

function Results({ view, points, d }: { view: StudentQuizView; points: number; d: Dict }) {
  return (
    <section className="card stack" style={{ gap: 10 }} aria-labelledby="quiz-results">
      <h2 id="quiz-results" style={{ fontSize: 22 }}>{d.quizYourAttempts}</h2>
      {!view.resultsShown && <p className="muted" style={{ margin: 0 }}>{d.quizResultsLater}</p>}
      <ul className="list">
        {view.attempts.map((x) => (
          <li key={x.number} style={{ display: "block" }}>
            <div className="row">
              <b className="grow">{d.quizAttempt} {x.number}</b>
              {x.counts && view.attempts.length > 1 && <span className="chip chip-done">{d.quizCounts}</span>}
              {x.autoSubmitted && <span className="chip">{d.quizAutoHandedIn}</span>}
              {x.score !== null && <span style={{ fontWeight: 800 }}>{x.score} / {points}</span>}
              {x.pending > 0 && <span className="chip">{d.quizWaitingTeacher}</span>}
              <time className="muted" suppressHydrationWarning style={{ fontSize: 13 }}>{x.submittedAt ? new Date(x.submittedAt).toLocaleString() : ""}</time>
            </div>
            {x.results && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", minHeight: 32 }}>{d.quizSeeAnswers}</summary>
                <ol className="stack" style={{ gap: 10, paddingLeft: 20, marginTop: 8 }}>
                  {x.results.map((r) => {
                    const mark = r.score === null ? d.quizWaitingTeacher : r.score >= r.points ? d.quizRight : r.score > 0 ? d.quizPartly : d.quizWrong;
                    return (
                      <li key={r.identifier}>
                        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.prompt}</p>
                        <p style={{ margin: "2px 0 0", fontSize: 14 }}>
                          <span className="muted">{d.quizYourAnswer}:</span> {r.yours || <i className="muted">{d.quizNoAnswer}</i>}
                        </p>
                        {r.answer && <p style={{ margin: "2px 0 0", fontSize: 14 }}><span className="muted">{d.quizRightAnswer}:</span> {r.answer}</p>}
                        <p style={{ margin: "2px 0 0", fontSize: 14 }}>
                          <span className={`chip ${r.score === null ? "" : r.score >= r.points ? "chip-done" : r.score > 0 ? "chip-late" : "chip-missing"}`}>{mark}</span>
                          {r.score !== null && <span className="muted"> {r.score} / {r.points}</span>}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
