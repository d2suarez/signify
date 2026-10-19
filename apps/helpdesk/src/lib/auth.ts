import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";

/**
 * Who is signed in comes from Signify ID, through server.js: signify-auth
 * checks the ID token (renewing it if it has to) and hands the claims to Next
 * on the x-signify-user header. server.js deletes any copy of that header a
 * browser sends, so its presence means the server put it there.
 *
 * The help desk keeps its own User row for each person so tickets, comments
 * and projects have somebody to point at. Signify ID is the source of truth;
 * that row is refreshed from the claims on every visit.
 */

export type SignifyClaims = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  role?: string | null;
  roleLabel?: string | null;
  isSuper?: boolean;
  isMinor?: boolean;
  tenantId?: string | null;
  tenantName?: string | null;
  perms?: Record<string, string>;
};

const USER_HEADER = "x-signify-user";

/** Only this school's members may use this help desk, when it is set. */
const SCHOOL_TENANT = process.env.HELPDESK_TENANT_ID || "";

export const readClaims = cache(async (): Promise<SignifyClaims | null> => {
  const raw = (await headers()).get(USER_HEADER);
  if (!raw) return null;
  try {
    const claims = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return claims && typeof claims.id === "string" && claims.email ? claims : null;
  } catch {
    return null;
  }
});

/** The help desk's four roles, from what Signify ID says this person may do. */
export function roleFromClaims(c: SignifyClaims): "ADMIN" | "TECH" | "STAFF" | "STUDENT" {
  const perms = c.perms || {};
  if (c.isSuper || perms["helpdesk:admin"]) return "ADMIN";
  if (perms["helpdesk:agent"]) return "TECH";
  if (c.role === "student") return "STUDENT";
  return "STAFF";
}

/** Signed in at Signify ID, but this help desk belongs to another school. */
export const wrongSchool = cache(async (): Promise<boolean> => {
  const c = await readClaims();
  return !!(c && SCHOOL_TENANT && !c.isSuper && c.tenantId !== SCHOOL_TENANT);
});

const SEEN_EVERY_MS = 60_000;

export const getCurrentUser = cache(async () => {
  const c = await readClaims();
  if (!c) return null;
  if (await wrongSchool()) return null;

  const data = {
    name: c.name || c.email.split("@")[0],
    email: c.email.toLowerCase(),
    picture: c.picture || "",
    role: roleFromClaims(c),
    roleLabel: c.roleLabel || "",
    tenantId: c.tenantId || null,
  };

  let user = await prisma.user.findUnique({ where: { signifyId: c.id } });

  if (!user) {
    // Someone new to the help desk. An address can change hands at a school,
    // so a row holding this address under a DIFFERENT Signify ID is released
    // (its address renamed) rather than merged into. A row with no Signify ID
    // at all is from before sign-in moved to Signify ID — that one is them.
    const byEmail = await prisma.user.findUnique({ where: { email: data.email } });
    if (byEmail && byEmail.signifyId === c.id) {
      return byEmail; // created a moment ago by a parallel request
    }
    if (byEmail && !byEmail.signifyId) {
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { ...data, signifyId: c.id, lastSeenAt: new Date() },
      });
    } else {
      if (byEmail) {
        await prisma.user.update({
          where: { id: byEmail.id },
          data: { email: `released+${byEmail.id}@${data.email.split("@")[1] || "invalid"}`, active: false },
        });
      }
      try {
        user = await prisma.user.create({
          data: { ...data, signifyId: c.id, lastSeenAt: new Date() },
        });
      } catch (e) {
        // A page fires several requests at once; on someone's first visit they
        // can race to create the same row. The loser just reads the winner's.
        if ((e as { code?: string }).code !== "P2002") throw e;
        user = await prisma.user.findUnique({ where: { signifyId: c.id } });
        if (!user) throw e;
      }
    }
    return user;
  }

  const changed =
    user.name !== data.name || user.email !== data.email || user.picture !== data.picture ||
    user.role !== data.role || user.roleLabel !== data.roleLabel || user.tenantId !== data.tenantId ||
    !user.active;
  const stale = !user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > SEEN_EVERY_MS;
  if (changed || stale) {
    if (data.email !== user.email) {
      const clash = await prisma.user.findUnique({ where: { email: data.email } });
      if (clash && clash.id !== user.id) {
        await prisma.user.update({
          where: { id: clash.id },
          data: { email: `released+${clash.id}@${data.email.split("@")[1] || "invalid"}`, active: false },
        });
      }
    }
    user = await prisma.user.update({
      where: { id: user.id },
      data: { ...data, active: true, lastSeenAt: new Date() },
    });
  }
  return user;
});

export function signInUrl(returnTo = "/") {
  return `/auth/login?return=${encodeURIComponent(returnTo)}`;
}

export async function requireUser(returnTo?: string) {
  const user = await getCurrentUser();
  if (!user) {
    if (await wrongSchool()) redirect("/login?wrong=1");
    let back = returnTo;
    if (!back) {
      const h = await headers();
      back = h.get("x-helpdesk-path") || "/";
      if (back.startsWith("/_next") || back.startsWith("/api/")) back = "/";
    }
    // Someone who has signed in here before goes straight through Signify ID
    // (usually without a click). Someone who signed out, or is new, sees the
    // sign-in page first rather than being pulled back in.
    const returning = (await cookies()).get("sfy_ret")?.value === "1";
    redirect(returning ? signInUrl(back) : `/login?return=${encodeURIComponent(back)}`);
  }
  return user;
}

export function isAgent(user: { role: string }) {
  return user.role === "ADMIN" || user.role === "TECH";
}

/** Help desk agents only (admins and technicians). */
export async function requireAgent() {
  const user = await requireUser();
  if (!isAgent(user)) redirect("/");
  return user;
}

export async function requireAdmin() {
  const user = await requireAgent();
  if (user.role !== "ADMIN") redirect("/dashboard");
  return user;
}
