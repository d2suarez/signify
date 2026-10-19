import fs from "fs/promises";
import { prisma } from "@/lib/db";
import { getCurrentUser, isAgent } from "@/lib/auth";
import { uploadPath, INLINE_TYPES } from "@/lib/files";

/**
 * One ticket attachment.
 *
 * This used to answer to anybody who asked, with no check at all: an id was
 * the whole credential, and ids travel — in links, in logs, in a forwarded
 * email. Photographs of a pupil's device, of a form, of a screen, were a
 * guessed or leaked string away from anyone on the internet.
 *
 * Who may have one now is exactly who may read its ticket:
 *   * an agent (admin or technician) sees every ticket, so every attachment;
 *   * a signed-in person sees the tickets they raised;
 *   * anyone holding the ticket's own secret token sees it, because that link
 *     is how a requester without an account follows their ticket. The token is
 *     passed as ?t=, so the capability travels with the request rather than
 *     being assumed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const attachment = await prisma.attachment.findUnique({
    where: { id },
    include: { ticket: { select: { token: true, requesterEmail: true } } },
  });
  if (!attachment) return new Response("Not found", { status: 404 });

  const suppliedToken = new URL(request.url).searchParams.get("t");
  let allowed = suppliedToken != null && suppliedToken === attachment.ticket.token;

  if (!allowed) {
    const user = await getCurrentUser();
    allowed =
      !!user &&
      (isAgent(user) ||
        user.email.toLowerCase() === attachment.ticket.requesterEmail.toLowerCase());
  }
  if (!allowed) return new Response("Not found", { status: 404 });

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(uploadPath(attachment.id));
  } catch {
    return new Response("File missing", { status: 404 });
  }

  // Only the handful of types saveAttachments() actually stores are shown in
  // the tab; anything else — an older row from before uploads were sniffed —
  // is handed over as a download, so it can never render as a page here.
  const inline = INLINE_TYPES.has(attachment.mimetype);

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": inline ? attachment.mimetype : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${attachment.filename.replace(/["\\]/g, "")}"`,
      // Belt and braces around the type: no sniffing, and nothing this
      // document contains may load or run anything, whatever the bytes turn
      // out to be. Deliberately not `sandbox`, which stops Chrome's built-in
      // PDF viewer from opening the file at all.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'none'; frame-ancestors 'self'",
      "Cache-Control": "private, no-store",
    },
  });
}
