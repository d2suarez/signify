import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireMe, readMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { addPeriod, deletePeriod, listPeriods } from "@/lib/grades";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return;
  const op = String(formData.get("op") || "");
  if (op === "add") await addPeriod(me.tenantId, formData.get("name"), formData.get("startsOn"), formData.get("endsOn"));
  if (op === "delete") await deletePeriod(me.tenantId, String(formData.get("periodId")));
  revalidatePath("/school/periods");
}

/** The school's grading periods. Everyone can see them; admins change them. */
export default async function PeriodsPage() {
  const me = await requireMe();
  const d = dict(await lang());
  const periods = await listPeriods(me.tenantId);
  const admin = isSchoolAdmin(me);

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>} />
      <main className="page stack" style={{ maxWidth: 760 }}>
        <h1 style={{ fontSize: 34 }}>{d.periods}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.periodsHint}</p>
        <p style={{ margin: 0 }}><Link href="/school/grading">{d.gradingSetupLink}</Link></p>
        {!admin && <p className="notice">{d.onlyAdmins}</p>}
        <section className="card">
          {periods.length === 0 && <p className="empty">{d.noPeriods}</p>}
          <ul className="list">
            {periods.map((p) => (
              <li key={p.id}>
                <span className="grow"><b>{p.name}</b> <span className="muted">{p.startsOn} – {p.endsOn}</span></span>
                {admin && (
                  <form action={act}>
                    <input type="hidden" name="periodId" value={p.id} />
                    <button className="btn btn-sm" name="op" value="delete">{d.delete}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {admin && (
            <form action={act} className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <div className="fieldset" style={{ flex: "1 1 160px" }}>
                <label htmlFor="p-name">{d.name}</label>
                <input id="p-name" name="name" className="field" placeholder={d.periodNamePlaceholder} maxLength={60} required />
              </div>
              <div className="fieldset" style={{ flex: "1 1 150px" }}>
                <label htmlFor="p-start">{d.starts}</label>
                <input id="p-start" name="startsOn" type="date" className="field" required />
              </div>
              <div className="fieldset" style={{ flex: "1 1 150px" }}>
                <label htmlFor="p-end">{d.ends}</label>
                <input id="p-end" name="endsOn" type="date" className="field" required />
              </div>
              <button className="btn btn-primary" name="op" value="add">{d.add}</button>
            </form>
          )}
        </section>
      </main>
    </>
  );
}
