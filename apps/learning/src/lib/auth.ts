import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { classesFor, childrenFor, type IdClass, type IdChild } from "./roster";

/**
 * Who is signed in comes from Signify ID, through server.js: signify-auth
 * checks the ID token (renewing it when it has to) and hands the claims to
 * Next on x-signify-user, and the token valid for this request on
 * x-signify-token. server.js deletes any copy of either header a browser
 * sends, so their presence means the server put them there.
 */

export type Me = {
  id: string;
  email: string;
  name: string;
  role: string | null;
  tenantId: string;
  tenantName: string;
  isMinor: boolean;
  dev: boolean;
};

export const USER_HEADER = "x-signify-user";
export const TOKEN_HEADER = "x-signify-token";

export const readMe = cache(async (): Promise<Me | null> => {
  const h = await headers();
  const raw = h.get(USER_HEADER);
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!c || typeof c.id !== "string" || !c.email) return null;
    return {
      id: c.id,
      email: c.email,
      name: c.name || c.email,
      role: c.role ?? null,
      // A person with no school (a platform admin) works in a space of their
      // own, so nothing they make lands in somebody's school.
      tenantId: c.tenantId || `user:${c.id}`,
      tenantName: c.tenantName || "",
      isMinor: !!c.isMinor,
      dev: c.sessionId === "dev-session",
    };
  } catch {
    return null;
  }
});

export async function requireMe(): Promise<Me> {
  const me = await readMe();
  if (!me) {
    const path = (await headers()).get("x-learning-path") || "/";
    redirect(`/auth/login?return=${encodeURIComponent(path)}`);
  }
  return me;
}

export async function token(): Promise<string> {
  return (await headers()).get(TOKEN_HEADER) || "";
}

export const myClasses = cache(async (): Promise<{ ok: boolean; classes: IdClass[] }> => {
  const me = await readMe();
  if (!me) return { ok: false, classes: [] };
  return classesFor({ id: me.id, role: me.role, dev: me.dev }, await token());
});

/** The signed-in parent's verified children, live from Signify ID. */
export const myChildren = cache(async (): Promise<{ ok: boolean; children: IdChild[] }> => {
  const me = await readMe();
  if (!me) return { ok: false, children: [] };
  return childrenFor({ id: me.id, role: me.role, dev: me.dev }, await token());
});
