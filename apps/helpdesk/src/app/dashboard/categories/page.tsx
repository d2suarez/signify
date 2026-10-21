import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PLACES_ADMIN_URL, getAllCategories, getLocations } from "@/lib/categories";
import { deleteCategory, moveCategory, setCategoryActive } from "@/lib/actions";
import { USER_ROLES } from "@/lib/labels";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Categories" };

const ASK_WORDS: Record<string, string> = { OPTIONAL: "optional", REQUIRED: "required" };

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const [categories, locations, counts] = await Promise.all([
    getAllCategories(),
    getLocations(user.tenantId),
    prisma.ticket.groupBy({ by: ["category"], _count: true }),
  ]);
  const ticketCount = new Map(counts.map((c) => [c.category, c._count]));

  return (
    <div className="max-w-3xl space-y-8">
      {sp.msg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{sp.msg}</div>
      )}
      {sp.err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{sp.err}</div>
      )}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Request categories</h1>
          <Link href="/dashboard/categories/new" className="btn-primary">New category</Link>
        </div>
        <p className="text-sm text-slate-500">
          The choices at the top of the request form. Each one shapes the rest of the form: what it asks
          for, and any extra questions of its own.
        </p>

        <ul className="space-y-3">
          {categories.map((c, index) => {
            const asks = [
              c.askLocation !== "HIDDEN" && `location (${ASK_WORDS[c.askLocation]})`,
              c.askDevice !== "HIDDEN" && `device (${ASK_WORDS[c.askDevice]})`,
              c.fields.length > 0 && `${c.fields.length} extra ${c.fields.length === 1 ? "question" : "questions"}`,
            ].filter(Boolean);
            const used = ticketCount.get(c.key) ?? 0;
            return (
              <li key={c.id} className={`card p-4 ${c.active ? "" : "opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span aria-hidden className={`shape shape-${c.shape} text-${c.color}`} />
                  <p className="font-semibold">{c.name}</p>
                  {c.nameEs && <span className="text-sm text-slate-400">· {c.nameEs}</span>}
                  {!c.active && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">Hidden</span>
                  )}
                  {c.roles.length < 4 &&
                    c.roles.map((role) => (
                      <span key={role} className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        {USER_ROLES[role] ?? role}
                      </span>
                    ))}
                </div>
                {c.hint && <p className="mt-0.5 text-sm text-slate-500">{c.hint}</p>}
                <p className="mt-1 text-xs text-slate-400">
                  Asks for {asks.length > 0 ? asks.join(", ") : "nothing extra"} · {used} {used === 1 ? "ticket" : "tickets"}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-sm">
                  <Link href={`/dashboard/categories/${c.id}`} className="font-medium text-blue-700 hover:underline">Edit</Link>
                  <form action={moveCategory.bind(null, c.id, -1)}>
                    <button disabled={index === 0} className="cursor-pointer font-medium text-slate-600 hover:underline disabled:cursor-default disabled:opacity-30" aria-label={`Move ${c.name} up`}>
                      ↑ Up
                    </button>
                  </form>
                  <form action={moveCategory.bind(null, c.id, 1)}>
                    <button disabled={index === categories.length - 1} className="cursor-pointer font-medium text-slate-600 hover:underline disabled:cursor-default disabled:opacity-30" aria-label={`Move ${c.name} down`}>
                      ↓ Down
                    </button>
                  </form>
                  <form action={setCategoryActive.bind(null, c.id, !c.active)}>
                    <SubmitButton className="cursor-pointer font-medium text-slate-600 hover:underline" pendingText="…">
                      {c.active ? "Hide" : "Show"}
                    </SubmitButton>
                  </form>
                  {used === 0 && (
                    <details>
                      <summary className="cursor-pointer font-medium text-red-600 hover:underline">Delete</summary>
                      <form action={deleteCategory.bind(null, c.id)} className="mt-2">
                        <SubmitButton className="btn-secondary text-red-600" pendingText="Deleting…">
                          Yes, delete this category
                        </SubmitButton>
                      </form>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section id="locations" className="space-y-4">
        <div>
          <h2 className="text-xl font-bold">Locations</h2>
          <p className="text-sm text-slate-500">
            The places in the Location dropdown come from your school&apos;s list in Signify ID, so every app
            offers the same rooms. People can still type a place that isn&apos;t listed.
          </p>
        </div>
        {PLACES_ADMIN_URL && (
          <a href={PLACES_ADMIN_URL} target="_blank" rel="noreferrer" className="btn-secondary">
            Edit places in Signify ID ↗
          </a>
        )}
        {locations.length === 0 ? (
          <div className="card px-6 py-8 text-center text-sm text-slate-500">
            No places yet. Until some are added in Signify ID (console → Places), people type where they are.
          </div>
        ) : (
          <div className="card p-4">
            <p className="mb-2 text-xs text-slate-400">
              {locations.length} {locations.length === 1 ? "place" : "places"}, in dropdown order. Changes in Signify ID show here within a minute.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {locations.map((name) => (
                <span key={name} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm text-slate-700">{name}</span>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
