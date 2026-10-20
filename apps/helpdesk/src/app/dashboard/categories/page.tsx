import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { getAllCategories } from "@/lib/categories";
import {
  addLocations,
  deleteCategory,
  moveCategory,
  moveLocation,
  removeLocation,
  renameLocation,
  setCategoryActive,
  sortLocationsByName,
} from "@/lib/actions";
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
  await requireAdmin();
  const sp = await searchParams;
  const [categories, locations, counts] = await Promise.all([
    getAllCategories(),
    prisma.location.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
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
            The places in the Location dropdown: rooms, the gym, the playground, the front office.
            People can still type a place that isn&apos;t listed. Removing one keeps it on old tickets.
          </p>
        </div>

        <form action={addLocations} className="card space-y-3 p-4">
          <label className="label" htmlFor="loc-names">Add places <span className="font-normal text-slate-400">(one per line, or paste a list)</span></label>
          <textarea id="loc-names" name="names" rows={3} className="input" placeholder={"Room 12\nGym\nPlayground\nFront office"} />
          <SubmitButton pendingText="Adding…">Add</SubmitButton>
        </form>

        {locations.length === 0 ? (
          <div className="card px-6 py-8 text-center text-sm text-slate-500">
            No places yet. Until you add some, people type where they are.
          </div>
        ) : (
          <div className="card divide-y divide-slate-100">
            <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-400">
              <span>{locations.length} {locations.length === 1 ? "place" : "places"}, in dropdown order</span>
              <form action={sortLocationsByName}>
                <button className="cursor-pointer font-medium text-blue-700 hover:underline">Sort A–Z</button>
              </form>
            </div>
            {locations.map((loc, index) => (
              <div key={loc.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <form action={renameLocation.bind(null, loc.id)} className="flex min-w-0 flex-1 items-center gap-2">
                  <input name="name" defaultValue={loc.name} maxLength={80} aria-label="Place name" className="input min-w-0 flex-1 py-1.5" />
                  <button className="btn-secondary px-2.5 py-1.5 text-xs">Rename</button>
                </form>
                <form action={moveLocation.bind(null, loc.id, -1)}>
                  <button disabled={index === 0} className="btn-secondary px-2.5 py-1.5 disabled:opacity-30" aria-label={`Move ${loc.name} up`}>↑</button>
                </form>
                <form action={moveLocation.bind(null, loc.id, 1)}>
                  <button disabled={index === locations.length - 1} className="btn-secondary px-2.5 py-1.5 disabled:opacity-30" aria-label={`Move ${loc.name} down`}>↓</button>
                </form>
                <form action={removeLocation.bind(null, loc.id)}>
                  <button className="btn-secondary px-2.5 py-1.5 text-red-600" aria-label={`Remove ${loc.name}`}>✕</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
