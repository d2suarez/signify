import "server-only";
import { cache } from "react";
import { prisma } from "./db";
import { parseFields, parseRoles, type FormFieldDef } from "./forms";

export type Ask = "HIDDEN" | "OPTIONAL" | "REQUIRED";
export const ASK_VALUES: Ask[] = ["HIDDEN", "OPTIONAL", "REQUIRED"];
export const SHAPES = ["square", "circle", "arch", "triangle"];
export const COLORS = ["p1", "p2", "p3", "p4"];

/** A category as the request form and the labels need it. */
export type CategoryView = {
  id: string;
  key: string;
  name: string;
  nameEs: string;
  hint: string;
  hintEs: string;
  shape: string;
  color: string;
  titlePrompt: string;
  askLocation: Ask;
  askDevice: Ask;
  fields: FormFieldDef[];
  roles: string[];
  active: boolean;
  sortOrder: number;
};

// The three the help desk has always had. Their keys are what old tickets
// already store, so they keep working however an admin renames them.
const STARTERS = [
  {
    key: "TECHNOLOGY",
    name: "Technology",
    nameEs: "Tecnología",
    hint: "Chromebooks, iPads, computers, Wi-Fi, projectors, accounts",
    hintEs: "Chromebooks, iPads, computadoras, Wi-Fi, proyectores, cuentas",
    shape: "square",
    color: "p2",
    titlePrompt: "e.g. Projector won't turn on",
    askLocation: "OPTIONAL",
    askDevice: "OPTIONAL",
  },
  {
    key: "MAINTENANCE",
    name: "Building",
    nameEs: "Edificio",
    hint: "Rooms, furniture, plumbing, lights, heating, grounds",
    hintEs: "Salones, muebles, plomería, luces, calefacción, áreas verdes",
    shape: "circle",
    color: "p1",
    titlePrompt: "e.g. Sink in the staff room is leaking",
    askLocation: "REQUIRED",
    askDevice: "HIDDEN",
  },
  {
    key: "OTHER",
    name: "Something else",
    nameEs: "Otra cosa",
    hint: "Anything that doesn't fit the others",
    hintEs: "Cualquier cosa que no encaje en las otras",
    shape: "arch",
    color: "p4",
    titlePrompt: "e.g. Need chairs set up for Friday's assembly",
    askLocation: "OPTIONAL",
    askDevice: "HIDDEN",
  },
];

let seeded: Promise<void> | null = null;

/** Creates the starter categories the first time anything asks for categories. */
function ensureStarters() {
  seeded ??= (async () => {
    if ((await prisma.category.count()) > 0) return;
    await prisma.category.createMany({
      data: STARTERS.map((c, i) => ({ ...c, sortOrder: i })),
    });
  })().catch((error) => {
    seeded = null;
    throw error;
  });
  return seeded;
}

function asAsk(value: string): Ask {
  return (ASK_VALUES as string[]).includes(value) ? (value as Ask) : "OPTIONAL";
}

function toView(c: {
  id: string; key: string; name: string; nameEs: string; hint: string; hintEs: string;
  shape: string; color: string; titlePrompt: string; askLocation: string; askDevice: string;
  fieldsJson: string; roles: string; active: boolean; sortOrder: number;
}): CategoryView {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    nameEs: c.nameEs,
    hint: c.hint,
    hintEs: c.hintEs,
    shape: SHAPES.includes(c.shape) ? c.shape : "arch",
    color: COLORS.includes(c.color) ? c.color : "p4",
    titlePrompt: c.titlePrompt,
    askLocation: asAsk(c.askLocation),
    askDevice: asAsk(c.askDevice),
    fields: parseFields(c.fieldsJson),
    roles: parseRoles(c.roles),
    active: c.active,
    sortOrder: c.sortOrder,
  };
}

/** Every category, hidden ones included, in the admin's order. One query per request. */
export const getAllCategories = cache(async (): Promise<CategoryView[]> => {
  await ensureStarters();
  const rows = await prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.map(toView);
});

/** The categories this person can pick on the request form. */
export async function categoriesFor(user: { role: string }): Promise<CategoryView[]> {
  return (await getAllCategories()).filter(
    (c) => c.active && (user.role === "ADMIN" || c.roles.includes(user.role))
  );
}

export async function categoryByKey(key: string): Promise<CategoryView | null> {
  return (await getAllCategories()).find((c) => c.key === key) ?? null;
}

/** Display name in the requester's language, falling back to English. */
export function categoryName(c: Pick<CategoryView, "name" | "nameEs">, lang: string) {
  return lang === "es" && c.nameEs ? c.nameEs : c.name;
}

export function categoryHint(c: Pick<CategoryView, "hint" | "hintEs">, lang: string) {
  return lang === "es" && c.hintEs ? c.hintEs : c.hint;
}

/* ---------- Places, from Signify ID ----------
   A school keeps its rooms and places once, in Signify ID (console → Places),
   and every app offers the same list. Asked with this app's own client
   credentials: it is a list of rooms, nothing about a person. Kept for a
   minute so a busy morning is not a request per page, and the last good list
   is used if Signify ID cannot be reached. */

const ISSUER = (process.env.SIGNIFY_ISSUER || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.SIGNIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SIGNIFY_CLIENT_SECRET || "";
const PLACES_TTL_MS = 60_000;
const placesCache = new Map<string, { at: number; list: string[] }>();

/** Where the school edits its places. */
export const PLACES_ADMIN_URL = ISSUER ? `${ISSUER}/admin` : "";

/** The school's places, in its own order. Empty when there is no school or no list yet. */
export async function getLocations(tenantId?: string | null): Promise<string[]> {
  const tenant = tenantId || process.env.HELPDESK_TENANT_ID || "";
  if (!tenant || !ISSUER || !CLIENT_ID || !CLIENT_SECRET) return [];
  const cached = placesCache.get(tenant);
  if (cached && Date.now() - cached.at < PLACES_TTL_MS) return cached.list;
  try {
    const res = await fetch(`${ISSUER}/api/v1/tenants/${encodeURIComponent(tenant)}/locations`, {
      headers: {
        authorization:
          "Basic " + Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString("base64"),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Signify ID answered ${res.status}`);
    const body = (await res.json()) as { locations?: unknown };
    const list = Array.isArray(body.locations) ? body.locations.filter((v): v is string => typeof v === "string") : [];
    placesCache.set(tenant, { at: Date.now(), list });
    return list;
  } catch (error) {
    console.error("Reading places from Signify ID failed:", error);
    return cached?.list ?? [];
  }
}

/**
 * Checks the extra questions of a category (or form) against what was sent,
 * and returns the answers to snapshot onto the ticket.
 */
export function readAnswers(
  defs: FormFieldDef[],
  get: (name: string) => unknown
): { error: string } | { values: { label: string; value: string }[] } {
  const values: { label: string; value: string }[] = [];
  for (const def of defs) {
    const raw = get(`f_${def.id}`);
    let value = typeof raw === "string" ? raw.trim().slice(0, 5000) : "";
    if (def.type === "CHECKBOX") value = raw === "on" || raw === true ? "Yes" : "No";
    if (def.required && def.type !== "CHECKBOX" && !value) {
      return { error: `Please fill in "${def.label}".` };
    }
    if (def.type === "SELECT" && value && !def.options.includes(value)) {
      return { error: `Invalid choice for "${def.label}".` };
    }
    if (value) values.push({ label: def.label, value });
  }
  return { values };
}
