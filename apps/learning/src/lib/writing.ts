import type { Queryable } from "./db";

/**
 * Writing-process evidence for online assignments: timed snapshots of the
 * text and paste events, recorded with the student's own autosave (so in the
 * same transaction as the work itself), replayed for the teacher on the
 * grading screen. It is evidence for a conversation, never a verdict: there
 * is no score, no "AI likelihood", nothing that labels a student.
 *
 * The pure parts (cleaning paste events, deciding when to snapshot, the
 * summary) are tested directly; record() runs inside saveDraft's transaction.
 */

export const WRITING = {
  snapshotEvery: 15_000,
  maxSnapshots: 400,
  maxPastesPerSave: 20,
  maxPasteText: 5_000,
  /** How long ago (ms) a paste may say it happened: it waits for the next autosave. */
  maxPasteAgo: 5 * 60_000,
  /** A pause longer than this starts a new writing session. */
  sessionGap: 30 * 60_000,
  /** Gaps up to this count as time spent writing. */
  activeGap: 5 * 60_000,
};

export type PasteIn = { ago: number; chars: number; text: string };

/** Paste events from a browser: at most 20 per save, text capped, numbers made sane. */
export function cleanPastes(input: unknown): PasteIn[] {
  if (!Array.isArray(input)) return [];
  const out: PasteIn[] = [];
  for (const raw of input.slice(0, WRITING.maxPastesPerSave)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.slice(0, WRITING.maxPasteText) : "";
    const chars = Math.max(text.length, Math.min(1_000_000, Math.round(Number(o.chars)) || 0));
    if (chars <= 0) continue;
    const ago = Math.min(WRITING.maxPasteAgo, Math.max(0, Math.round(Number(o.ago)) || 0));
    out.push({ ago, chars, text });
  }
  return out;
}

export function shouldSnapshot(last: { at: number; body: string } | null, body: string, now: number, count: number, force = false): boolean {
  if (last && last.body === body) return false;
  if (force) return true;
  if (count >= WRITING.maxSnapshots) return false;
  return !last || now - last.at >= WRITING.snapshotEvery;
}

export type WritingEvent = { kind: "snapshot" | "paste"; at: string; body: string; chars: number };

export type WritingSummary = {
  firstAt: string | null;
  lastAt: string | null;
  sessions: number;
  activeMinutes: number;
  snapshots: number;
  pastes: number;
  pastedChars: number;
  largestPaste: number;
};

/** Plain facts about the events, in order. No judgement is computed here or anywhere. */
export function summarize(events: WritingEvent[]): WritingSummary {
  const times = events.map((e) => new Date(e.at).getTime()).sort((a, b) => a - b);
  let sessions = times.length ? 1 : 0;
  let active = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > WRITING.sessionGap) sessions++;
    if (gap <= WRITING.activeGap) active += gap;
  }
  const pastes = events.filter((e) => e.kind === "paste");
  return {
    firstAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    sessions,
    activeMinutes: Math.round(active / 60_000),
    snapshots: events.length - pastes.length,
    pastes: pastes.length,
    pastedChars: pastes.reduce((n, p) => n + p.chars, 0),
    largestPaste: pastes.reduce((n, p) => Math.max(n, p.chars), 0),
  };
}

/** Called inside saveDraft / setHandedIn's transaction, with the student's own submission. */
export async function record(t: Queryable, tenantId: string, submissionId: string, body: string, pastes: PasteIn[], force = false) {
  for (const p of pastes) {
    await t.query(
      `INSERT INTO writing_events (tenant_id, submission_id, kind, at, body, chars)
       VALUES ($1, $2, 'paste', now() - make_interval(secs => $3::double precision / 1000), $4, $5)`,
      [tenantId, submissionId, p.ago, p.text, p.chars],
    );
  }
  const rows = await t.query<{ at: Date | string; body: string; n: number }>(
    `SELECT at, body, (SELECT count(*)::int FROM writing_events WHERE tenant_id = $1 AND submission_id = $2 AND kind = 'snapshot') AS n
       FROM writing_events WHERE tenant_id = $1 AND submission_id = $2 AND kind = 'snapshot'
      ORDER BY at DESC, id DESC LIMIT 1`,
    [tenantId, submissionId],
  );
  const last = rows[0] ? { at: new Date(rows[0].at).getTime(), body: String(rows[0].body) } : null;
  if (shouldSnapshot(last, body, Date.now(), Number(rows[0]?.n ?? 0), force)) {
    await t.query(
      "INSERT INTO writing_events (tenant_id, submission_id, kind, body, chars) VALUES ($1, $2, 'snapshot', $3, $4)",
      [tenantId, submissionId, body, body.length],
    );
  }
}

/** Every event for one student's submission, oldest first (teachers only: the route checks). */
export async function writingEvents(q: Queryable, tenantId: string, assignmentId: string, studentId: string): Promise<WritingEvent[]> {
  const rows = await q.query(
    `SELECT w.kind, w.at, w.body, w.chars FROM writing_events w JOIN submissions s ON s.id = w.submission_id
      WHERE w.tenant_id = $1 AND s.tenant_id = $1 AND s.assignment_id = $2 AND s.student_id = $3
      ORDER BY w.at, w.id`,
    [tenantId, assignmentId, studentId],
  );
  return rows.map((r) => ({ kind: r.kind as WritingEvent["kind"], at: new Date(r.at as string).toISOString(), body: String(r.body), chars: Number(r.chars) }));
}
