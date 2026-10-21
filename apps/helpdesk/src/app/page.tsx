import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canUseForm } from "@/lib/forms";
import { getDict } from "@/lib/lang";
import { categoriesFor, categoryHint, categoryName, getLocations } from "@/lib/categories";
import { SiteHeader } from "@/components/site-header";
import { SubmitForm } from "@/components/submit-form";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ device?: string }>;
}) {
  const user = await requireUser();
  const { t, lang } = await getDict();
  const sp = await searchParams;
  const activeForms = await prisma.form.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });
  const forms = activeForms.filter((form) => canUseForm(user, form));
  const [categories, locations] = await Promise.all([categoriesFor(user), getLocations(user.tenantId)]);
  const kinds = categories.map((c) => ({
    key: c.key,
    name: categoryName(c, lang),
    hint: categoryHint(c, lang),
    shape: c.shape,
    color: c.color,
    titlePrompt: c.titlePrompt,
    askLocation: c.askLocation,
    askDevice: c.askDevice,
    fields: c.fields,
  }));

  const scannedDevice = sp.device
    ? await prisma.device.findUnique({ where: { tag: sp.device.toUpperCase() } })
    : null;

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <form method="GET" action="/kb" className="mb-8 flex items-center gap-2">
          <input
            type="search"
            name="q"
            placeholder={t.searchPlaceholder}
            className="input flex-1"
          />
          <button type="submit" className="btn-secondary whitespace-nowrap">{t.searchBtn}</button>
        </form>

        {forms.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
              {t.requestForms}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {forms.map((form) => (
                <Link
                  key={form.id}
                  href={`/f/${form.id}`}
                  className="card block p-4 transition hover:border-blue-300"
                >
                  <p className="flex items-center gap-2 font-semibold">
                    <span aria-hidden className="shape shape-triangle text-p3" />
                    {form.name}
                  </p>
                  {form.description && (
                    <p className="mt-1 text-sm text-slate-500">{form.description}</p>
                  )}
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">
            {forms.length > 0 ? t.orTitle : t.needHelpTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {t.heroBody} {t.submittingAs}{" "}
            <span className="font-medium text-slate-800">{user.name}</span> ({user.email}).
          </p>
        </div>

        <div className="card p-5 sm:p-8">
          <SubmitForm
            t={t}
            kinds={kinds}
            locations={locations}
            prefill={
              scannedDevice
                ? {
                    deviceTag: scannedDevice.tag,
                    deviceLabel: `${scannedDevice.tag}${scannedDevice.model ? ` (${scannedDevice.model})` : ""}`,
                    location: scannedDevice.location,
                  }
                : null
            }
          />
        </div>
      </main>
    </div>
  );
}
