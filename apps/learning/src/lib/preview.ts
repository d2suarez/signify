import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireMe, token, type Me } from "./auth";
import { previewPeopleFor, previewClassesOf, previewChildrenOf, type IdClass, type IdChild, type PreviewPerson } from "./roster";

/**
 * "Preview as": a teacher or school admin sees what one of Signify ID's mock
 * practice people (a made-up student or parent) sees, read-only.
 *
 * A preview never acts as the person. The signed-in person stays who they
 * are on every request (server.js never changes it, and every API and server
 * action re-checks them as before); preview pages only READ, rendering with
 * the mock's classes and children that ID gives the viewer. They hold no
 * forms, no server actions and no live join. Signify ID decides who may
 * preview whom (mocks only, the class's teacher or a school admin) and
 * audits every lookup; every page view is also logged here.
 */

export type PreviewSubject = PreviewPerson & { classes: IdClass[]; children: IdChild[] };
export type Preview = { me: Me; who: PreviewSubject; base: string };

/** The mock people the signed-in person may preview (empty for most people). */
export const myPreviewPeople = cache(async (): Promise<{ ok: boolean; people: PreviewPerson[] }> => {
  const me = await requireMe();
  return previewPeopleFor({ id: me.id, role: me.role, dev: me.dev }, await token());
});

export function previewLog(me: Me, who: PreviewPerson, what: string): void {
  console.info(`learning: preview ${me.id} viewed ${what} as ${who.kind} ${who.id}`);
}

/**
 * The person a /preview/[personId]/… page shows, or 404 when the viewer may
 * not preview them (ID names only mocks the viewer may see). `failed` when
 * Signify ID couldn't be asked: the page says so rather than showing nothing.
 */
export async function previewFor(personId: string, what: string): Promise<Preview | "failed"> {
  const me = await requireMe();
  if (!/^[0-9a-z-]{8,64}$/i.test(personId)) notFound();
  const listed = await myPreviewPeople();
  if (!listed.ok) return "failed";
  const person = listed.people.find((p) => p.id === personId);
  if (!person) notFound();
  const who = { id: me.id, role: me.role, dev: me.dev };
  const tok = await token();
  const [cls, kids] = await Promise.all([
    person.kind === "student" ? previewClassesOf(who, tok, person.id) : Promise.resolve({ ok: true, classes: [] as IdClass[] }),
    person.kind === "parent" ? previewChildrenOf(who, tok, person.id) : Promise.resolve({ ok: true, children: [] as IdChild[] }),
  ]);
  if (!cls.ok || !kids.ok) return "failed";
  previewLog(me, person, what);
  return { me, who: { ...person, classes: cls.classes, children: kids.children }, base: `/preview/${person.id}` };
}
