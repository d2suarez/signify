import "server-only";
import { DESK_ORIGIN } from "./desk";

/**
 * A one-use ticket that signs the rail's Teacher's Desk frame in as this
 * person (apps/desk/server/embed.js), asked for server to server with the
 * Signify ID token Learning holds for them, exactly as the seating slide
 * asks (desk-seating.ts). Desk checks the token was minted for Learning and
 * asks Signify ID whether the person may open the desk; it never trusts
 * anything Learning says about who they are.
 *
 * Locally the made-up person has no token, and a desk run with
 * DESK_DEV_USER is signed in already, so there is nothing to ask.
 */
export type DeskTicket = { ok: true; ticket: string } | { ok: false; status: number; reason: "signin" | "denied" | "desk" | "dev" };

export async function deskTicket(who: { dev: boolean }, token: string): Promise<DeskTicket> {
  if (who.dev) return { ok: false, status: 404, reason: "dev" };
  if (!token) return { ok: false, status: 401, reason: "signin" };
  let res: Response;
  try {
    res = await fetch(`${DESK_ORIGIN}/api/learning/embed-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn("learning: Teacher's Desk unreachable for the rail —", (e as Error).message);
    return { ok: false, status: 502, reason: "desk" };
  }
  const body = await res.json().catch(() => null) as { ticket?: unknown; error?: unknown } | null;
  if (res.ok && body && typeof body.ticket === "string" && /^[\w-]{20,200}$/.test(body.ticket)) return { ok: true, ticket: body.ticket };
  console.warn(`learning: Teacher's Desk rail ticket refused (${res.status})`, body && body.error);
  if (res.status === 401) return { ok: false, status: 401, reason: "signin" };
  if (res.status === 403) return { ok: false, status: 403, reason: "denied" };
  return { ok: false, status: 502, reason: "desk" };
}
