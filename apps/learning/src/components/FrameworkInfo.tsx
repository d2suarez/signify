import type { Dict } from "@/lib/i18n";
import type { Framework } from "@/lib/standards-library";

/** Where a framework comes from and on what terms: version, publisher, license, source and the notice it must carry. */
export function FrameworkInfo({ f, d }: { f: Framework; d: Dict }) {
  const kind = f.ownerKind === "library" ? d.stdKindLibrary : f.ownerKind === "school" ? d.stdKindSchool : f.courseId ? d.stdKindCourse : d.stdKindTeacher;
  return (
    <dl className="std-info">
      <dt>{d.stdKind}</dt><dd>{kind}</dd>
      {f.version && <><dt>{d.stdVersion}</dt><dd>{f.version}</dd></>}
      {(f.publisher || f.creator) && <><dt>{d.stdPublisher}</dt><dd>{f.publisher || f.creator}</dd></>}
      {f.subjects.length > 0 && <><dt>{d.stdSubject}</dt><dd>{f.subjects.join(", ")}</dd></>}
      <dt>{d.stdItems}</dt><dd>{f.itemCount}</dd>
      {f.licenseTitle && (
        <><dt>{d.stdLicense}</dt><dd>{f.licenseUri ? <a href={f.licenseUri} target="_blank" rel="noopener noreferrer">{f.licenseTitle}</a> : f.licenseTitle}
          {f.licenseText && <span className="muted" style={{ display: "block", fontSize: 13 }} lang="en">{f.licenseText}</span>}</dd></>
      )}
      {f.officialSourceUrl && <><dt>{d.stdOfficial}</dt><dd><a href={f.officialSourceUrl} target="_blank" rel="noopener noreferrer">{d.stdOfficialLink}</a></dd></>}
      {f.dataSource && <><dt>{d.stdData}</dt><dd lang="en">{f.dataSource}</dd></>}
      {f.copiedFrom && <><dt>{d.stdCopiedFrom}</dt><dd><a href={`/standards?f=${f.copiedFrom}`}>{d.stdOriginal}</a></dd></>}
      {f.superseded && <><dt>{d.stdNewer}</dt><dd>{d.stdSuperseded}</dd></>}
      {f.distribution === "school" && f.ownerKind === "library" && <><dt>{d.stdTerms}</dt><dd>{d.stdSchoolTermsNote}</dd></>}
      {f.notice && <><dt>{d.stdNotice}</dt><dd lang={f.language}>{f.notice}</dd></>}
    </dl>
  );
}

/** The copyright lines of the frameworks whose text is on the page, once each. */
export function Notices({ notices, d }: { notices: (string | null | undefined)[]; d: Dict }) {
  const list = [...new Set(notices.filter((n): n is string => !!n))];
  if (!list.length) return null;
  return (
    <footer className="muted std-notices" style={{ fontSize: 12 }} aria-label={d.stdNotice}>
      {list.map((n) => <p key={n} lang="en" style={{ margin: "4px 0" }}>{n}</p>)}
    </footer>
  );
}
