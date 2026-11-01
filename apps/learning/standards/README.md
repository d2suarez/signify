# Standards library seeds

Each `<key>@<version>.json` is one published set, built by `scripts/standards-seeds.mjs` from a public machine-readable file (a CASE package or the Common Standards Project), or for the NAD from its PDFs. Never type standards by hand. `manifest.json` lists what `ensureLibrary()` loads. Sources, licenses and why each may be used: the `SOURCES` list in the script and PLAN.md ("Standards library sources").

`framework.jurisdiction` is the US state's postal code (`VA`, `GA`, ...) or `NAD`; multi-state sets (Common Core, NGSS) have none. A set whose terms don't clearly allow a product that is sold has `distribution: "school"`: a school admin turns it on at `/school/standards`, accepting the terms.

## NAD (Adventist) standards

17 sets (`nad-*`), added 2026-10-31 on Desmond's go-ahead, `jurisdiction: "NAD"`, `distribution: "school"`, with the NAD's copyright line as the notice. The NAD publishes them only as PDFs, so `scripts/nad-standards.mjs` reads each PDF's own text by where it sits on the page (pdfjs-dist, not shipped with the app):

```
npm i --no-save pdfjs-dist@4.10.38
node scripts/standards-seeds.mjs --fetch <rawDir> --only nad-
node scripts/standards-seeds.mjs <rawDir> --only nad-
```

The build stops if a page's code count and the standards read differ, or a statement holds page header text; it prints misprints it corrected (each listed in the `misprints` of its `SOURCES` entry), codes printed twice, and words split across lines; and it checks the elementary codes against the NAD's grade-level PDFs. What it couldn't place is in PLAN.md ("Standards library sources"). A school follows them on `/school/standards` by picking "North American Division (Adventist)".
