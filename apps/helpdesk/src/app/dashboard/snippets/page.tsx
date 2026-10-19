import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { deleteSnippet, saveSnippet } from "@/lib/actions";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Saved replies" };

export default async function SnippetsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  await requireAgent();
  const sp = await searchParams;
  const snippets = await prisma.snippet.findMany({ orderBy: { title: "asc" } });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Saved replies</h1>
        <Link href="/dashboard" className="text-sm font-medium text-blue-700 hover:underline">
          ← Tickets
        </Link>
      </div>

      {sp.msg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {sp.msg}
        </div>
      )}
      {sp.err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {sp.err}
        </div>
      )}

      <p className="text-sm text-slate-500">
        Replies you type over and over — password reset steps, &ldquo;bring it to the
        office&rdquo;, loaner instructions. Insert them with one click from any ticket&apos;s
        update box.
      </p>

      {snippets.length > 0 && (
        <ul className="space-y-3">
          {snippets.map((snippet) => (
            <li key={snippet.id} className="card p-4">
              <p className="font-semibold">{snippet.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{snippet.body}</p>
              <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-sm">
                <details className="flex-1">
                  <summary className="cursor-pointer font-medium text-blue-700 hover:underline">
                    Edit
                  </summary>
                  <form action={saveSnippet.bind(null, snippet.id)} className="mt-3 space-y-3">
                    <input name="title" defaultValue={snippet.title} required className="input" />
                    <textarea name="body" defaultValue={snippet.body} required rows={4} className="input" />
                    <SubmitButton className="btn-secondary" pendingText="Saving…">Save</SubmitButton>
                  </form>
                </details>
                <form action={deleteSnippet.bind(null, snippet.id)}>
                  <SubmitButton
                    className="cursor-pointer font-medium text-red-600 hover:underline"
                    pendingText="…"
                  >
                    Delete
                  </SubmitButton>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="card p-5">
        <h2 className="mb-4 text-base font-semibold">New saved reply</h2>
        <form action={saveSnippet.bind(null, null)} className="space-y-3">
          <div>
            <label className="label" htmlFor="new-title">Name</label>
            <input id="new-title" name="title" required className="input" placeholder='e.g. "Password reset steps"' />
          </div>
          <div>
            <label className="label" htmlFor="new-body">Reply text</label>
            <textarea id="new-body" name="body" required rows={4} className="input" />
          </div>
          <SubmitButton pendingText="Saving…">Add saved reply</SubmitButton>
        </form>
      </section>
    </div>
  );
}
