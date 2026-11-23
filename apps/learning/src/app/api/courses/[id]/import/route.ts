import { NextResponse } from "next/server";
import { academicAccess as courseAccess, ctx, updatesViewer } from "@/lib/access";
import { asView, setStudentView } from "@/lib/organize";
import { CartridgeError } from "@/lib/cartridge";
import { previewImport, commitImport, MAX_UPLOAD } from "@/lib/cc-import";

export const dynamic = "force-dynamic";

const SCHOOL_TZ = "America/New_York";

/**
 * Common Cartridge import, teachers only. The body is the export file itself.
 * ?step=preview reads it and says what it would make, writing nothing;
 * ?step=import (with keepDates=1|0 and name=<file name>) writes it all in one
 * transaction. Both take nested=1 (folders inside folders become units) and
 * import takes view=hidden|list|thread (what students see of the pages;
 * thread also posts each to the class's Updates, after the import). Errors come back as { error: code } for the page to word.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "teachers-only" }, { status: 403 });

  const url = new URL(req.url);
  const step = url.searchParams.get("step");
  if (step !== "preview" && step !== "import") return NextResponse.json({ error: "bad-step" }, { status: 400 });

  const buf = await readCapped(req, MAX_UPLOAD);
  if (buf === "too-large") return NextResponse.json({ error: "upload-too-large" }, { status: 413 });
  if (!buf.length) return NextResponse.json({ error: "empty" }, { status: 400 });

  const nested = url.searchParams.get("nested") === "1";
  const view = asView(url.searchParams.get("view")) ?? "hidden";
  try {
    if (step === "preview") {
      return NextResponse.json({ preview: await previewImport(ctx(access.me), access.course.id, buf, SCHOOL_TZ, nested) });
    }
    const name = (url.searchParams.get("name") || "").replace(/[\u0000-\u001f]/g, "").slice(0, 200);
    const result = await commitImport(ctx(access.me), access.course.id, buf, name, {
      keepDates: url.searchParams.get("keepDates") === "1", schoolTz: SCHOOL_TZ, nestedUnits: nested, studentView: view,
    });
    let posted = 0;
    if (view === "thread" && result.lessonIds.length) {
      // Last first, so the class's Updates (newest on top) read in the export's order.
      const viewer = await updatesViewer();
      if (viewer) posted = await setStudentView(viewer, access.course.id, [...result.lessonIds].reverse(), "thread").catch(() => 0);
    }
    return NextResponse.json({ result: { ...result, posted } });
  } catch (e) {
    if (e instanceof CartridgeError) return NextResponse.json({ error: e.code }, { status: 422 });
    throw e;
  }
}

/** The request body, refusing as soon as it passes `max` bytes (never buffering more). */
async function readCapped(req: Request, max: number): Promise<Buffer | "too-large"> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return "too-large";
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
