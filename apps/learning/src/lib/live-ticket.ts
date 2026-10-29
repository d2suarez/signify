import crypto from "node:crypto";

/**
 * A live ticket says: this person may teach (or follow) this course's live
 * lesson, until this time. Next signs it after checking the course and the
 * person's role; live.js checks only the signature and that the ticket
 * belongs to whoever is on the socket.
 */

export type LiveTicket = {
  sub: string;      // Signify user id
  name: string;
  course: string;   // course id
  role: "teacher" | "student";
  lesson?: string;  // the lesson a teacher may present
  exp: number;      // ms since epoch
};

const HOURS = 12;

export function signTicket(t: Omit<LiveTicket, "exp">, secret = process.env.LEARNING_LIVE_SECRET || ""): string {
  if (!secret) throw new Error("LEARNING_LIVE_SECRET is not set (server.js sets it at boot).");
  const body = Buffer.from(JSON.stringify({ ...t, exp: Date.now() + HOURS * 3600_000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

type LiveSession = { lessonId: string; index: number; count: number };

/** Which lesson is live in a course right now, if any (live.js state, same process). */
export function liveLessonId(courseId: string): string | null {
  const sessions = (globalThis as unknown as { __learningLive?: Map<string, LiveSession> }).__learningLive;
  return sessions?.get(courseId)?.lessonId ?? null;
}
