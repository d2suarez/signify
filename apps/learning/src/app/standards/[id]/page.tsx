import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe, readMe } from "@/lib/auth";
import { lang, standardsViewer } from "@/lib/access";
import {
  addItem, archiveFramework, archiveItem, canEdit, frameworkItems, getFramework, importCsv, updateFramework, updateItem, FRAMEWORK_LIMITS,
} from "@/lib/standards-library";
import { CSV_LIMITS, gradeSpan, type CsvProblem } from "@/lib/standards-csv";
import { dict, type Dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { FrameworkInfo, Notices } from "@/components/FrameworkInfo";

export const dynamic = "force-dynamic";

const MAX_CSV = 1_000_000;

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  const v = me && await standardsViewer(me);
  if (!v) return;
  const id = String(formData.get("frameworkId") || "");
  const op = String(formData.get("op") || "");
  const itemId = String(formData.get("itemId") || "");
  const item = { code: formData.get("code"), statement: formData.get("statement"), grades: formData.get("grades"), type: formData.get("type"), parentId: formData.get("parentId") };
  if (op === "meta") await updateFramework(v, id, { title: formData.get("title"), subject: formData.get("subject"), version: formData.get("version") });
  if (op === "add") await addItem(v, id, item);
  if (op === "save") await updateItem(v, itemId, item);
  if (op === "archive" || op === "restore") await archiveItem(v, itemId, op === "archive");
  if (op === "archive-set" || op === "restore-set") await archiveFramework(v, id, op === "archive-set");
  if (op === "csv") {
    const file = formData.get("file");
    let text = String(formData.get("csv") || "");
    if (file && typeof file === "object" && "size" in file && file.size > 0) {
      if (file.size > MAX_CSV) redirect(`/standards/${id}?csv=big`);
      text = await file.text();
    }
    if (text.length > MAX_CSV) redirect(`/standards/${id}?csv=big`);
    const r = await importCsv(v, id, text);
    if (r && r.problems.length) redirect(`/standards/${id}?csv=${encodeURIComponent(r.problems.slice(0, 20).map((p) => `${p.line}:${p.problem}`).join(","))}`);
    if (r) redirect(`/standards/${id}?csv=ok:${r.added}`);
  }
  revalidatePath(`/standards/${id}`);
}

function problemText(p: string, d: Dict): string {
  const [line, kind] = p.split(":");
  const word: Record<CsvProblem["problem"], string> = { noStatement: d.csvNoStatement, unknownParent: d.csvUnknownParent, duplicateCode: d.csvDuplicateCode, tooMany: d.csvTooMany };
  return `${d.csvLine} ${line}: ${word[kind as CsvProblem["problem"]] ?? kind}`;
}

/** A school or teacher framework: its details, its items (edit, add, archive) and CSV import. Library sets are read-only (browse them in the library). */
export default async function FrameworkPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ csv?: string; q?: string }> }) {
  const me = await requireMe();
  const v = await standardsViewer(me);
  if (!v) notFound();
  const { id } = await params;
  const sp = await searchParams;
  const d = dict(await lang());
  const f = await getFramework(v, id);
  if (!f) notFound();
  if (!canEdit(v, f)) redirect(`/standards?f=${f.id}`);
  const all = await frameworkItems(v, f.id, { withArchived: true });
  const words = (sp.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const live = all.filter((i) => !i.archived && words.every((w) => `${i.code} ${i.statement}`.toLowerCase().includes(w)));
  const shown = live.slice(0, 300);
  const archived = all.filter((i) => i.archived);
  const parents = all.filter((i) => !i.archived && i.depth < 5);
  const csv = sp.csv ?? "";
  const hidden = (k: string, val: string) => <input type="hidden" name={k} value={val} />;

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href="/standards">{d.standardsLibrary}</Link></>} />
      <main className="page stack" style={{ maxWidth: 1000 }}>
        <h1 style={{ fontSize: 30 }} lang={f.language}>{f.title}</h1>
        {f.archived && <p className="notice">{d.stdArchivedSet}</p>}
        <section className="card stack" style={{ gap: 10 }} aria-labelledby="meta">
          <h2 id="meta" className="label">{d.stdAbout}</h2>
          <form action={act} className="row" style={{ alignItems: "flex-end" }}>
            {hidden("frameworkId", f.id)}{hidden("op", "meta")}
            <div className="fieldset" style={{ flex: "2 1 260px" }}>
              <label htmlFor="mt">{d.title}</label>
              <input id="mt" name="title" className="field" defaultValue={f.title} maxLength={FRAMEWORK_LIMITS.title} required />
            </div>
            <div className="fieldset" style={{ flex: "1 1 160px" }}>
              <label htmlFor="ms">{d.stdSubject}</label>
              <input id="ms" name="subject" className="field" defaultValue={f.subjects[0] ?? ""} maxLength={FRAMEWORK_LIMITS.subject} />
            </div>
            <div className="fieldset" style={{ flex: "1 1 110px" }}>
              <label htmlFor="mv">{d.stdVersion}</label>
              <input id="mv" name="version" className="field" defaultValue={f.version} maxLength={40} />
            </div>
            <button className="btn btn-primary">{d.save}</button>
          </form>
          <FrameworkInfo f={f} d={d} />
          <form action={act}>{hidden("frameworkId", f.id)}
            <button className="btn btn-sm" name="op" value={f.archived ? "restore-set" : "archive-set"}>{f.archived ? d.restore : d.stdArchiveSet}</button>
          </form>
        </section>

        <section className="card stack" style={{ gap: 8 }} aria-labelledby="items">
          <h2 id="items" className="label">{d.stdItemsTitle} ({live.length})</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.stdItemsHint}</p>
          {all.length > 30 && (
            <form method="get" className="row" role="search">
              <input name="q" type="search" className="field" style={{ flex: "1 1 220px", width: "auto" }} defaultValue={sp.q ?? ""} aria-label={d.filterStandards} placeholder={d.filterStandards} />
              <button className="btn btn-sm">{d.search}</button>
            </form>
          )}
          <ul className="list">
            {shown.map((i) => (
              <li key={i.id} style={{ paddingLeft: Math.min(i.depth, 6) * 18 }}>
                <form action={act} className="row grow">
                  {hidden("frameworkId", f.id)}{hidden("itemId", i.id)}
                  <input name="code" className="field" style={{ width: 120 }} defaultValue={i.code} maxLength={CSV_LIMITS.code} aria-label={`${d.standardCode} ${i.code}`} />
                  <textarea name="statement" className="field" style={{ flex: "1 1 280px", width: "auto", minHeight: 44 }} defaultValue={i.statement} maxLength={CSV_LIMITS.statement} aria-label={`${d.stdStatement} ${i.code}`} required rows={2} />
                  <input name="grades" className="field" style={{ width: 90 }} defaultValue={gradeSpan(i.grades, "K", "PK")} aria-label={`${d.stdGrades} ${i.code}`} placeholder={d.stdGrades} />
                  <input type="hidden" name="type" value={i.type ?? ""} />
                  <button className="btn btn-sm" name="op" value="save">{d.save}</button>
                  <button className="btn btn-sm" name="op" value="archive">{d.archive}</button>
                </form>
              </li>
            ))}
          </ul>
          {live.length > shown.length && <p className="muted">{d.stdFirstN.replace("{n}", String(shown.length))}</p>}
          <form action={act} className="row" style={{ alignItems: "flex-end", borderTop: "1px solid var(--line, #ddd)", paddingTop: 10 }}>
            {hidden("frameworkId", f.id)}{hidden("op", "add")}
            <div className="fieldset" style={{ width: 130 }}>
              <label htmlFor="ac">{d.standardCode}</label>
              <input id="ac" name="code" className="field" maxLength={CSV_LIMITS.code} />
            </div>
            <div className="fieldset" style={{ flex: "2 1 280px" }}>
              <label htmlFor="as">{d.stdStatement}</label>
              <textarea id="as" name="statement" className="field" maxLength={CSV_LIMITS.statement} required rows={2} />
            </div>
            <div className="fieldset" style={{ width: 110 }}>
              <label htmlFor="ag">{d.stdGrades}</label>
              <input id="ag" name="grades" className="field" placeholder="K-2" />
            </div>
            <div className="fieldset" style={{ flex: "1 1 200px" }}>
              <label htmlFor="ap">{d.stdUnder}</label>
              <select id="ap" name="parentId" className="field" defaultValue="">
                <option value="">{d.stdTopLevel}</option>
                {parents.map((p) => <option key={p.id} value={p.id}>{"  ".repeat(p.depth)}{(p.code ? `${p.code} · ` : "") + p.statement.slice(0, 70)}</option>)}
              </select>
            </div>
            <button className="btn btn-primary">{d.stdAddItem}</button>
          </form>
          {archived.length > 0 && (
            <details>
              <summary>{d.stdArchivedItems} ({archived.length})</summary>
              <ul className="list">
                {archived.map((i) => (
                  <li key={i.id}>
                    <form action={act} className="row grow">
                      {hidden("frameworkId", f.id)}{hidden("itemId", i.id)}
                      <span className="grow"><b>{i.code}</b> {i.statement}</span>
                      <button className="btn btn-sm" name="op" value="restore">{d.restore}</button>
                    </form>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="card stack" style={{ gap: 8 }} aria-labelledby="csv-title">
          <h2 id="csv-title" className="label">{d.csvImport}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.csvImportHint}</p>
          <pre className="muted" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>code,statement,grades,parent{"\n"}B.1,Biblical Foundations,K-8,{"\n"}B.1.1,Identify God as Creator,1,B.1</pre>
          {csv.startsWith("ok:") && <p className="notice" role="status">{d.csvAdded.replace("{n}", csv.slice(3))}</p>}
          {csv === "big" && <p className="notice notice-bad" role="alert">{d.csvTooBig}</p>}
          {csv && !csv.startsWith("ok:") && csv !== "big" && (
            <div className="notice notice-bad" role="alert">
              <p style={{ margin: 0 }}>{d.csvNothingAdded}</p>
              <ul>{csv.split(",").map((p) => <li key={p}>{problemText(p, d)}</li>)}</ul>
            </div>
          )}
          <form action={act} className="stack" style={{ gap: 8 }}>
            {hidden("frameworkId", f.id)}{hidden("op", "csv")}
            <label className="stack" style={{ gap: 4 }}>{d.csvFile}
              <input type="file" name="file" accept=".csv,text/csv,text/plain" className="field" />
            </label>
            <label className="stack" style={{ gap: 4 }}>{d.csvPaste}
              <textarea name="csv" className="field" rows={5} />
            </label>
            <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.csvImportButton}</button>
          </form>
        </section>
        <Notices notices={[f.notice]} d={d} />
      </main>
    </>
  );
}
