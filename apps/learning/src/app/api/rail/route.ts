import { NextResponse } from "next/server";
import { readMe, myClasses } from "@/lib/auth";
import { ctx } from "@/lib/access";
import { myCourses } from "@/lib/courses";
import { audienceOf, placeOf, railFor } from "@/lib/rail";
import { saveOwnWidgets } from "@/lib/widget-store";

export const dynamic = "force-dynamic";

/**
 * The left rail for a page: GET ?path=<the page's path>&todo=1 gives the
 * person's tools there (and the To do lists with todo=1).
 */
export async function GET(req: Request) {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const url = new URL(req.url);
  const path = (url.searchParams.get("path") || "/").slice(0, 300);
  const rail = await railFor(me, path, url.searchParams.get("todo") === "1");
  return NextResponse.json(rail, { headers: { "Cache-Control": "no-store" } });
}

/** Body: { path, widgets: kinds in order } or { path, widgets: null } (back to the defaults). Only the person's own list. */
export async function PUT(req: Request) {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 2_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a list of tools." }, { status: 400 });
  }
  const { classes } = await myClasses();
  const courses = await myCourses(me.tenantId, classes, me.id);
  const { place } = await placeOf(me, String(body.path || "/").slice(0, 300));
  const widgets = body.widgets === null ? null : Array.isArray(body.widgets) ? body.widgets : [];
  const r = await saveOwnWidgets(ctx(me), audienceOf(me, courses), place, widgets);
  return NextResponse.json({ widgets: r.widgets, defaults: r.defaults, addable: r.addable, from: r.from });
}
