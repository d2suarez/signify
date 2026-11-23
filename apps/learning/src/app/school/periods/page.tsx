import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe, readMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { deletePeriod, listPeriods, savePeriod, type Period } from "@/lib/grades";
import { childrenOf } from "@/lib/periods";
import { dict, type Dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

const PROBLEMS = ["dates", "parent", "outside", "overlap", "depth", "children", "missing"] as const;

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return;
  const op = String(formData.get("op") || "");
  const id = String(formData.get("periodId") || "");
  let error = "";
  if (op === "add" || op === "save") {
    const r = await savePeriod(me.tenantId, op === "add" ? null : id, {
      name: formData.get("name"), startsOn: formData.get("startsOn"), endsOn: formData.get("endsOn"),
      parentId: String(formData.get("parentId") || "") || null,
    });
    if (!r.ok) error = r.reason;
  }
  if (op === "delete") await deletePeriod(me.tenantId, id);
  revalidatePath("/school/periods");
  redirect(error ? `/school/periods?error=${error}${id ? `&p=${id}` : ""}` : "/school/periods");
}

function problemText(d: Dict, e: string): string {
  return ({
    dates: d.periodErrDates, parent: d.periodErrParent, outside: d.periodErrOutside, overlap: d.periodErrOverlap,
    depth: d.periodErrDepth, children: d.periodErrChildren, missing: d.periodErrMissing,
  } as Record<string, string>)[e] ?? "";
}

/** Every period that `p` may sit inside: not itself, nothing it holds. */
function parentChoices(periods: Period[], p: Period | null): Period[] {
  if (!p) return periods;
  const below = new Set<string>([p.id]);
  for (const x of periods) if (x.parentId && below.has(x.parentId)) below.add(x.id); // tree order: parents come first
  return periods.filter((x) => !below.has(x.id));
}

function PeriodFields({ d, periods, p, idp }: { d: Dict; periods: Period[]; p: Period | null; idp: string }) {
  return (
    <>
      <div className="fieldset" style={{ flex: "1 1 160px" }}>
        <label htmlFor={`${idp}-name`}>{d.name}</label>
        <input id={`${idp}-name`} name="name" className="field" placeholder={d.periodNamePlaceholder} maxLength={60} required defaultValue={p?.name} />
      </div>
      <div className="fieldset" style={{ flex: "1 1 150px" }}>
        <label htmlFor={`${idp}-start`}>{d.starts}</label>
        <input id={`${idp}-start`} name="startsOn" type="date" className="field" required defaultValue={p?.startsOn} />
      </div>
      <div className="fieldset" style={{ flex: "1 1 150px" }}>
        <label htmlFor={`${idp}-end`}>{d.ends}</label>
        <input id={`${idp}-end`} name="endsOn" type="date" className="field" required defaultValue={p?.endsOn} />
      </div>
      <div className="fieldset" style={{ flex: "1 1 180px" }}>
        <label htmlFor={`${idp}-parent`}>{d.periodInside}</label>
        <select id={`${idp}-parent`} name="parentId" className="field" defaultValue={p?.parentId ?? ""}>
          <option value="">{d.periodTopLevel}</option>
          {parentChoices(periods, p).map((x) => (
            <option key={x.id} value={x.id}>{"  ".repeat(x.depth)}{x.name}</option>
          ))}
        </select>
      </div>
    </>
  );
}

/**
 * The school's grading periods, nested (a year > semesters > quarters).
 * Everyone signed in sees them; only school admins change them.
 */
export default async function PeriodsPage({ searchParams }: { searchParams: Promise<{ error?: string; p?: string }> }) {
  const me = await requireMe();
  const d = dict(await lang());
  const sp = await searchParams;
  const periods = await listPeriods(me.tenantId);
  const admin = isSchoolAdmin(me);
  const error = PROBLEMS.includes(sp.error as (typeof PROBLEMS)[number]) ? sp.error! : "";

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>} />
      <main className="page stack" style={{ maxWidth: 760 }}>
        <h1 style={{ fontSize: 34 }}>{d.periods}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.periodsHint}</p>
        <p style={{ margin: 0 }}><Link href="/school/grading">{d.gradingSetupLink}</Link></p>
        {!admin && <p className="notice">{d.onlyAdmins}</p>}
        {admin && error && <p className="notice notice-bad" role="alert">{problemText(d, error)}</p>}
        <section className="card">
          {periods.length === 0 && <p className="empty">{d.noPeriods}</p>}
          <ul className="list period-tree">
            {periods.map((p) => {
              const kids = childrenOf(periods, p.id);
              return (
                <li key={p.id} style={{ paddingInlineStart: `${p.depth * 22}px`, flexWrap: "wrap" }}>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <b>{p.name}</b> <span className="muted">{p.startsOn} – {p.endsOn}</span>
                    {kids.length > 0 && <><br /><span className="muted" style={{ fontSize: 13 }}>{d.periodHolds.replace("{list}", kids.map((k) => k.name).join(", "))}</span></>}
                  </span>
                  {admin && (
                    <details style={{ flex: "1 1 100%" }} open={sp.p === p.id && !!error}>
                      <summary className="btn btn-sm" style={{ display: "inline-flex" }}>{d.periodChange}<span className="sr-only"> {p.name}</span></summary>
                      <form action={act} className="row" style={{ marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                        <input type="hidden" name="periodId" value={p.id} />
                        <PeriodFields d={d} periods={periods} p={p} idp={`p-${p.id}`} />
                        <button className="btn btn-primary" name="op" value="save">{d.save}</button>
                      </form>
                      <form action={act} className="row" style={{ marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <input type="hidden" name="periodId" value={p.id} />
                        <button className="btn btn-sm" name="op" value="delete">{d.delete}<span className="sr-only"> {p.name}</span></button>
                        {kids.length > 0 && <span className="muted" style={{ fontSize: 13 }}>{d.periodDeleteHint}</span>}
                      </form>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
          {admin && (
            <form action={act} className="row" style={{ marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <h2 className="label" style={{ flex: "1 1 100%", margin: 0 }}>{d.periodAdd}</h2>
              <PeriodFields d={d} periods={periods} p={null} idp="new" />
              <button className="btn btn-primary" name="op" value="add">{d.add}</button>
            </form>
          )}
        </section>
      </main>
    </>
  );
}
