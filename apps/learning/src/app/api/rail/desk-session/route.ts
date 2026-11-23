import { NextResponse } from "next/server";
import { readMe, token } from "@/lib/auth";
import { deskTicket } from "@/lib/desk-session";

export const dynamic = "force-dynamic";

/**
 * The rail's Teacher's Desk frame asks for this when Desk has no sign-in of
 * its own in this browser (src/components/rail/DeskFrame.tsx): Learning's
 * server asks Desk, with the Signify ID token it holds for the person, for a
 * one-use ticket the frame trades for a frame-only session
 * (apps/desk/server/embed.js). The token itself never reaches the browser.
 */
export async function POST() {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const answer = await deskTicket(me, await token());
  return NextResponse.json(answer.ok ? { ticket: answer.ticket } : { error: answer.reason },
    { status: answer.ok ? 200 : answer.status, headers: { "Cache-Control": "no-store" } });
}
