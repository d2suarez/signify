"use client";

import { useState } from "react";
import type { Dict, Key } from "@/lib/i18n";
import { blankItem, ITEM_KINDS, newItemId, quizPoints, type ItemKind, type Quiz, type QuizItem, type QuizSettings } from "@/lib/quiz";

type Option = { id: string; name: string; description: string };

/**
 * A quiz's questions and settings, inside the assignment form (saved and
 * versioned with it). Every change goes up through onChange; the server
 * cleans it again with normalizeQuiz.
 */
export default function QuizEditor({ quiz, onChange, standards, attempted, d }: {
  quiz: Quiz; onChange: (q: Quiz) => void; standards?: Option[]; attempted: number; d: Dict;
}) {
  const [adding, setAdding] = useState<ItemKind>("single");
  const set = (patch: Partial<QuizSettings>) => onChange({ ...quiz, settings: { ...quiz.settings, ...patch } });
  const setItem = (k: number, it: QuizItem) => onChange({ ...quiz, items: quiz.items.map((x, j) => (j === k ? it : x)) });
  const move = (k: number, dir: -1 | 1) => {
    const j = k + dir;
    if (j < 0 || j >= quiz.items.length) return;
    const items = [...quiz.items];
    [items[k], items[j]] = [items[j], items[k]];
    onChange({ ...quiz, items });
  };
  const remove = (k: number) => { if (confirm(d.quizRemoveConfirm)) onChange({ ...quiz, items: quiz.items.filter((_, j) => j !== k) }); };
  const copy = (k: number) => {
    const it = quiz.items[k];
    const ids = new Map<string, string>();
    const re = (id: string) => { if (!ids.has(id)) ids.set(id, it.kind === "truefalse" ? id : newItemId()); return ids.get(id)!; };
    const dup: QuizItem = {
      ...it, identifier: newItemId(),
      choices: it.choices.map((c) => ({ ...c, identifier: re(c.identifier) })),
      targets: it.targets.map((c) => ({ ...c, identifier: re(c.identifier) })),
      correct: it.kind === "match" ? it.correct.map((p) => p.split(" ").map(re).join(" ")) : it.kind === "short" ? it.correct : it.correct.map(re),
    };
    onChange({ ...quiz, items: [...quiz.items.slice(0, k + 1), dup, ...quiz.items.slice(k + 1)] });
  };
  const add = () => onChange({ ...quiz, items: [...quiz.items, blankItem(adding, { true: d.quizTrue, false: d.quizFalse })] });
  const kindName = (k: ItemKind) => d[`qk_${k}` as Key];

  return (
    <div className="stack">
      <fieldset className="card stack" style={{ gap: 10 }}>
        <legend className="label" style={{ float: "left", padding: 0 }}>{d.quizSettings}</legend>
        <div className="row" style={{ clear: "both", alignItems: "flex-end" }}>
          <div className="fieldset" style={{ flex: "1 1 140px", marginTop: 0 }}>
            <label htmlFor="qz-attempts">{d.quizAttempts}</label>
            <select id="qz-attempts" className="field" value={quiz.settings.attempts} onChange={(e) => set({ attempts: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
              <option value={0}>{d.quizUnlimited}</option>
            </select>
          </div>
          <div className="fieldset" style={{ flex: "1 1 160px", marginTop: 0 }}>
            <label htmlFor="qz-keep">{d.quizKeep}</label>
            <select id="qz-keep" className="field" value={quiz.settings.keep} disabled={quiz.settings.attempts === 1}
              onChange={(e) => set({ keep: e.target.value === "latest" ? "latest" : "highest" })}>
              <option value="highest">{d.quizKeepHighest}</option>
              <option value="latest">{d.quizKeepLatest}</option>
            </select>
          </div>
          <div className="fieldset" style={{ flex: "1 1 140px", marginTop: 0 }}>
            <label htmlFor="qz-limit">{d.quizTimeLimit} <span className="muted" style={{ fontWeight: 400 }}>({d.quizMinutes})</span></label>
            <input id="qz-limit" type="number" min={0} max={600} className="field" value={quiz.settings.timeLimit ?? ""} placeholder={d.quizNone}
              onChange={(e) => set({ timeLimit: e.target.value ? Math.max(0, Number(e.target.value)) || null : null })} />
          </div>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <label className="check"><input type="checkbox" checked={quiz.settings.shuffleItems} onChange={(e) => set({ shuffleItems: e.target.checked })} />{d.quizShuffleItems}</label>
          <label className="check"><input type="checkbox" checked={quiz.settings.shuffleChoices} onChange={(e) => set({ shuffleChoices: e.target.checked })} />{d.quizShuffleChoices}</label>
        </div>
        <div className="fieldset" style={{ marginTop: 0 }}>
          <label htmlFor="qz-results">{d.quizResultsWhen}</label>
          <select id="qz-results" className="field" value={quiz.settings.results} onChange={(e) => set({ results: e.target.value === "on-hand-in" ? "on-hand-in" : "on-release" })}>
            <option value="on-release">{d.quizResultsOnRelease}</option>
            <option value="on-hand-in">{d.quizResultsOnHandIn}</option>
          </select>
        </div>
        <label className="check" style={{ whiteSpace: "normal" }}><input type="checkbox" checked={quiz.settings.showAnswers} onChange={(e) => set({ showAnswers: e.target.checked })} />{d.quizShowAnswers}</label>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizAccommodationsHint}</p>
      </fieldset>

      {attempted > 0 && <p className="notice">{d.quizRegradeNote.replace("{n}", String(attempted))}</p>}

      <section className="stack" aria-labelledby="qz-questions">
        <div className="row">
          <h2 id="qz-questions" className="grow" style={{ fontSize: 20 }}>{d.quizQuestions} · {quiz.items.length}</h2>
          <span className="muted">{quizPoints(quiz)} {d.pts}</span>
        </div>
        {quiz.items.length === 0 && <p className="empty">{d.quizNoQuestions}</p>}
        <ol className="quiz-items">
          {quiz.items.map((it, k) => (
            <li key={it.identifier} className="card stack" style={{ gap: 8 }}>
              <div className="row">
                <b className="grow">{d.quizQuestion} {k + 1} · {kindName(it.kind)}</b>
                <button type="button" className="btn btn-sm" disabled={k === 0} onClick={() => move(k, -1)} aria-label={`${d.moveUp}: ${d.quizQuestion} ${k + 1}`}>↑</button>
                <button type="button" className="btn btn-sm" disabled={k === quiz.items.length - 1} onClick={() => move(k, 1)} aria-label={`${d.moveDown}: ${d.quizQuestion} ${k + 1}`}>↓</button>
                <button type="button" className="btn btn-sm" onClick={() => copy(k)}>{d.quizDuplicate}</button>
                <button type="button" className="btn btn-sm" onClick={() => remove(k)}>{d.quizRemove}</button>
              </div>
              <ItemFields item={it} onChange={(x) => setItem(k, x)} standards={standards} d={d} />
            </li>
          ))}
        </ol>
        <div className="row card">
          <label htmlFor="qz-add-kind" className="sr-only">{d.quizQuestionType}</label>
          <select id="qz-add-kind" className="field" style={{ width: "auto", flex: "1 1 220px" }} value={adding} onChange={(e) => setAdding(e.target.value as ItemKind)}>
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
          </select>
          <button type="button" className="btn btn-primary" onClick={add}>{d.quizAddQuestion}</button>
        </div>
      </section>
    </div>
  );
}

function ItemFields({ item: it, onChange, standards, d }: {
  item: QuizItem; onChange: (i: QuizItem) => void; standards?: Option[]; d: Dict;
}) {
  const id = (s: string) => `qi-${it.identifier}-${s}`;
  const set = (patch: Partial<QuizItem>) => onChange({ ...it, ...patch });
  const setChoice = (k: number, text: string) => set({ choices: it.choices.map((c, j) => (j === k ? { ...c, text } : c)) });
  const addChoice = () => set({ choices: [...it.choices, { identifier: newItemId(), text: "" }] });
  const dropChoice = (k: number) => {
    const gone = it.choices[k].identifier;
    set({ choices: it.choices.filter((_, j) => j !== k), correct: it.correct.filter((x) => x !== gone && !x.startsWith(`${gone} `)) });
  };

  return (
    <>
      <div className="fieldset" style={{ marginTop: 0 }}>
        <label htmlFor={id("prompt")}>{d.quizPrompt}</label>
        <textarea id={id("prompt")} className="field" rows={3} maxLength={5000} value={it.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </div>

      {(it.kind === "single" || it.kind === "multiple") && (
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{it.kind === "single" ? d.quizChoicesPickOne : d.quizChoicesPickAll}</legend>
          {it.choices.map((c, k) => (
            <div key={c.identifier} className="row" style={{ gap: 8 }}>
              <label className="check" style={{ minWidth: 92 }}>
                <input type={it.kind === "single" ? "radio" : "checkbox"} name={id("correct")} checked={it.correct.includes(c.identifier)}
                  onChange={(e) => set({ correct: it.kind === "single" ? [c.identifier] : e.target.checked ? [...it.correct, c.identifier] : it.correct.filter((x) => x !== c.identifier) })} />
                {d.quizCorrect}
              </label>
              <label htmlFor={id(`c${k}`)} className="sr-only">{d.choice} {k + 1}</label>
              <input id={id(`c${k}`)} className="field grow" style={{ flex: "1 1 200px", width: "auto" }} maxLength={1000} value={c.text} onChange={(e) => setChoice(k, e.target.value)} />
              <button type="button" className="btn btn-sm" disabled={it.choices.length <= 2} onClick={() => dropChoice(k)} aria-label={`${d.quizRemove}: ${d.choice} ${k + 1}`}>×</button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={it.choices.length >= 20} onClick={addChoice}>+ {d.choice}</button>
            {it.kind === "multiple" && <label className="check"><input type="checkbox" checked={it.partial} onChange={(e) => set({ partial: e.target.checked })} />{d.quizPartial}</label>}
          </div>
          {it.correct.length === 0 && <p className="notice" style={{ margin: 0 }}>{d.quizNoKey}</p>}
        </fieldset>
      )}

      {it.kind === "truefalse" && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.quizRightAnswer}</legend>
          <div className="seg">
            {(["true", "false"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={it.correct[0] === v} onClick={() => set({ correct: [v] })}>{v === "true" ? d.quizTrue : d.quizFalse}</button>
            ))}
          </div>
        </fieldset>
      )}

      {it.kind === "short" && (
        <div className="fieldset" style={{ marginTop: 0 }}>
          <label htmlFor={id("accepted")}>{d.quizAccepted}</label>
          <textarea id={id("accepted")} className="field" rows={3} value={it.correct.join("\n")} aria-describedby={id("accepted-hint")}
            onChange={(e) => set({ correct: e.target.value.split("\n").slice(0, 20) })} />
          <p id={id("accepted-hint")} className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizAcceptedHint}</p>
          <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={it.caseSensitive} onChange={(e) => set({ caseSensitive: e.target.checked })} />{d.quizCaseSensitive}</label>
        </div>
      )}

      {it.kind === "numeric" && (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="fieldset" style={{ flex: "1 1 140px", marginTop: 0 }}>
            <label htmlFor={id("value")}>{d.quizRightAnswer}</label>
            <input id={id("value")} className="field" inputMode="decimal" value={it.value ?? ""}
              onChange={(e) => { const v = e.target.value.trim().replace(",", "."); set({ value: v === "" || !Number.isFinite(Number(v)) ? null : Number(v) }); }} />
          </div>
          <div className="fieldset" style={{ flex: "1 1 140px", marginTop: 0 }}>
            <label htmlFor={id("tol")}>{d.quizTolerance}</label>
            <input id={id("tol")} className="field" type="number" min={0} step="any" value={it.tolerance}
              onChange={(e) => set({ tolerance: Math.abs(Number(e.target.value)) || 0 })} />
          </div>
        </div>
      )}

      {it.kind === "match" && (
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.quizPairs}</legend>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizPairsHint}</p>
          {it.choices.map((c, k) => {
            const pair = it.correct.find((p) => p.startsWith(`${c.identifier} `));
            const tId = pair?.split(" ")[1];
            const t = it.targets.find((x) => x.identifier === tId);
            const setPair = (left: string, right: string) => {
              let targets = it.targets, correct = it.correct;
              let tid = tId;
              if (!t) { tid = newItemId(); targets = [...targets, { identifier: tid, text: right }]; correct = [...correct.filter((p) => !p.startsWith(`${c.identifier} `)), `${c.identifier} ${tid}`]; }
              else targets = targets.map((x) => (x.identifier === tid ? { ...x, text: right } : x));
              onChange({ ...it, choices: it.choices.map((x, j) => (j === k ? { ...x, text: left } : x)), targets, correct });
            };
            return (
              <div key={c.identifier} className="row" style={{ gap: 8 }}>
                <label htmlFor={id(`l${k}`)} className="sr-only">{d.quizPairLeft} {k + 1}</label>
                <input id={id(`l${k}`)} className="field" style={{ flex: "1 1 160px", width: "auto" }} value={c.text} maxLength={1000} placeholder={d.quizPairLeft}
                  onChange={(e) => setPair(e.target.value, t?.text ?? "")} />
                <span aria-hidden>→</span>
                <label htmlFor={id(`r${k}`)} className="sr-only">{d.quizPairRight} {k + 1}</label>
                <input id={id(`r${k}`)} className="field" style={{ flex: "1 1 160px", width: "auto" }} value={t?.text ?? ""} maxLength={1000} placeholder={d.quizPairRight}
                  onChange={(e) => setPair(c.text, e.target.value)} />
                <button type="button" className="btn btn-sm" disabled={it.choices.length <= 2}
                  onClick={() => onChange({ ...it, choices: it.choices.filter((_, j) => j !== k), targets: it.targets.filter((x) => x.identifier !== tId), correct: it.correct.filter((p) => !p.startsWith(`${c.identifier} `)) })}
                  aria-label={`${d.quizRemove}: ${k + 1}`}>×</button>
              </div>
            );
          })}
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={it.choices.length >= 20}
              onClick={() => { const s = newItemId(), t = newItemId(); onChange({ ...it, choices: [...it.choices, { identifier: s, text: "" }], targets: [...it.targets, { identifier: t, text: "" }], correct: [...it.correct, `${s} ${t}`] }); }}>
              + {d.quizPair}
            </button>
            <label className="check"><input type="checkbox" checked={it.partial} onChange={(e) => set({ partial: e.target.checked })} />{d.quizPartial}</label>
          </div>
        </fieldset>
      )}

      {it.kind === "order" && (
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.quizOrderRight}</legend>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizOrderEditHint}</p>
          {it.choices.map((c, k) => (
            <div key={c.identifier} className="row" style={{ gap: 8 }}>
              <span className="muted" style={{ minWidth: 20 }}>{k + 1}.</span>
              <label htmlFor={id(`o${k}`)} className="sr-only">{d.quizStep} {k + 1}</label>
              <input id={id(`o${k}`)} className="field" style={{ flex: "1 1 200px", width: "auto" }} value={c.text} maxLength={1000}
                onChange={(e) => { const choices = it.choices.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)); set({ choices, correct: choices.map((x) => x.identifier) }); }} />
              <button type="button" className="btn btn-sm" disabled={k === 0} aria-label={`${d.moveUp}: ${k + 1}`}
                onClick={() => { const choices = [...it.choices]; [choices[k - 1], choices[k]] = [choices[k], choices[k - 1]]; set({ choices, correct: choices.map((x) => x.identifier) }); }}>↑</button>
              <button type="button" className="btn btn-sm" disabled={it.choices.length <= 2} aria-label={`${d.quizRemove}: ${k + 1}`}
                onClick={() => { const choices = it.choices.filter((_, j) => j !== k); set({ choices, correct: choices.map((x) => x.identifier) }); }}>×</button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={it.choices.length >= 20}
              onClick={() => { const choices = [...it.choices, { identifier: newItemId(), text: "" }]; set({ choices, correct: choices.map((x) => x.identifier) }); }}>+ {d.quizStep}</button>
            <label className="check"><input type="checkbox" checked={it.partial} onChange={(e) => set({ partial: e.target.checked })} />{d.quizPartial}</label>
          </div>
        </fieldset>
      )}

      {it.kind === "essay" && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizEssayHint}</p>}

      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="fieldset" style={{ flex: "0 1 120px", marginTop: 0 }}>
          <label htmlFor={id("pts")}>{d.points}</label>
          <input id={id("pts")} className="field" type="number" min={0} max={1000} step="any" value={it.points}
            onChange={(e) => set({ points: Math.max(0, Number(e.target.value) || 0) })} />
        </div>
        {standards && standards.length > 0 && (
          <div className="fieldset" style={{ flex: "1 1 200px", marginTop: 0 }}>
            <label htmlFor={id("std")}>{d.quizStandard}</label>
            <select id={id("std")} className="field" value={it.standardId ?? ""} onChange={(e) => set({ standardId: e.target.value || null })}>
              <option value="">{d.quizNoStandard}</option>
              {standards.map((s) => <option key={s.id} value={s.id}>{s.name}{s.description ? ` · ${s.description}` : ""}</option>)}
            </select>
          </div>
        )}
      </div>
    </>
  );
}
