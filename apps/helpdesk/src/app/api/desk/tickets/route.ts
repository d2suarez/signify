import { getCurrentUser } from "@/lib/auth";
import { createTicketFor } from "@/lib/tickets";
import { APP_URL } from "@/lib/mail";

export const dynamic = "force-dynamic";

const CATEGORIES = ["TECHNOLOGY", "MAINTENANCE", "OTHER"];
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

/** A request sent from the ticket box on Teacher's Desk. */
export async function POST(request: Request) {
  // Only JSON, which a plain cross-site form can't send without a preflight
  // that server.js answers for the Desk's origin alone.
  if (!(request.headers.get("content-type") || "").includes("application/json")) {
    return Response.json({ error: "Send JSON." }, { status: 415 });
  }
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please connect the help desk first.", signedIn: false }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That request couldn't be read." }, { status: 400 });
  }
  const text = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : "");

  const category = text("category", 20);
  const title = text("title", 200);
  const priority = text("priority", 10) || "NORMAL";
  if (!CATEGORIES.includes(category)) return Response.json({ error: "Pick what kind of help you need." }, { status: 400 });
  if (!title) return Response.json({ error: "Say in a few words what you need." }, { status: 400 });
  if (!PRIORITIES.includes(priority)) return Response.json({ error: "That priority isn't one we know." }, { status: 400 });

  const ticket = await createTicketFor(user, {
    category,
    title,
    priority,
    description: text("description", 10000),
    location: text("location", 200),
    device: text("device", 200),
    source: "DESK",
  });
  return Response.json({ ok: true, id: ticket.id, url: `${APP_URL}/t/${ticket.token}` }, { status: 201 });
}
