import { NextResponse } from "next/server";
import { readMe } from "@/lib/auth";
import { ctx } from "@/lib/access";
import { getPrefs, savePrefs } from "@/lib/prefs-store";

export const dynamic = "force-dynamic";

/** The signed-in person's own reading supports. Nobody reads or sets anyone else's. */
export async function GET() {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ prefs: await getPrefs(ctx(me)) }, { headers: { "Cache-Control": "no-store" } });
}

/** Body: the whole set of choices (see src/lib/prefs.ts); anything unknown falls back to the default. */
export async function PUT(req: Request) {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 4_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a set of choices." }, { status: 400 });
  }
  return NextResponse.json({ prefs: await savePrefs(ctx(me), body) });
}
