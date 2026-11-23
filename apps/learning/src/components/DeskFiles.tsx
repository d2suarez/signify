"use client";

import type { WorkFile } from "@/lib/hand-in-files";
import type { Dict } from "@/lib/i18n";

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * A student's handed-in files beside the grading panel (story 01 A7):
 * photos shown in order, PDFs shown in the browser's viewer, Word /
 * PowerPoint / Excel to download. "Photos as one PDF" when there are two
 * or more photos.
 */
export default function DeskFiles({ assignmentId, studentId, files, handed, d }: {
  assignmentId: string; studentId: string; files: WorkFile[]; handed: boolean; d: Dict;
}) {
  const photos = files.filter((f) => f.kind === "image");
  let n = 0;
  return (
    <section className="desk-files stack" style={{ gap: 10, marginTop: 12 }} aria-labelledby="desk-files-title">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <h3 id="desk-files-title" className="label grow" style={{ margin: 0 }}>{handed ? d.wfDeskTitle : d.wfDeskNow} ({files.length})</h3>
        {photos.length > 1 && (
          <a className="btn btn-sm" href={`/work-files/photos/${assignmentId}?student=${encodeURIComponent(studentId)}`} target="_blank" rel="noopener">📄 {d.wfOnePdf}</a>
        )}
      </div>
      {files.map((f) => {
        const src = `/work-files/${f.id}`;
        if (f.kind === "image") {
          n++;
          const label = d.wfPhotoOf.replace("{n}", String(n)).replace("{total}", String(photos.length));
          return (
            <figure key={f.id} className="desk-photo">
              <a href={src} target="_blank" rel="noopener"><img src={src} alt={`${label}: ${f.name}`} loading="lazy" /></a>
              <figcaption className="muted">{label} · {f.name}</figcaption>
            </figure>
          );
        }
        if (f.kind === "pdf") {
          return (
            <div key={f.id} className="desk-pdf">
              <iframe src={src} title={f.name} loading="lazy" />
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                {f.name} · {kb(f.size)} · <a href={src} target="_blank" rel="noopener">{d.wfOpen}</a> · <a href={`${src}?download=1`}>{d.wfDownload}</a>
              </p>
            </div>
          );
        }
        return (
          <p key={f.id} style={{ margin: 0 }}>
            <a className="btn btn-sm" href={src} download>⬇ {f.name}</a> <span className="muted" style={{ fontSize: 13 }}>{kb(f.size)}</span>
          </p>
        );
      })}
    </section>
  );
}
