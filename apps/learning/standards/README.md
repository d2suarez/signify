# Standards library seeds

Each `<key>@<version>.json` is one published set, built by `scripts/standards-seeds.mjs` from a public machine-readable file (a CASE package or the Common Standards Project). Never type or scrape standards by hand. `manifest.json` lists what `ensureLibrary()` loads. Sources, licenses and why each may be used: the `SOURCES` list in the script and PLAN.md ("Standards library sources").

`framework.jurisdiction` is the US state's postal code (`VA`, `GA`, ...) or `NAD`; multi-state sets (Common Core, NGSS) have none. A set whose terms don't clearly allow a product that is sold has `distribution: "school"`: a school admin turns it on at `/school/standards`, accepting the terms.

## NAD (Adventist) standards: waiting

Not added. The NAD's standards are copyrighted ("may not be used without permission") and published only as PDFs. When the NAD Office of Education gives written permission and a spreadsheet or CASE file:

1. Add one `SOURCES` entry per subject (keys `nad-bible`, `nad-math`, ..., `jurisdiction: "NAD"`, `distribution: "school"`, the permission as the license fields and notice). A spreadsheet needs a small reader next to `fromCsp`.
2. Run the script, commit the new files and `manifest.json`.
3. Richmond Academy's admin then follows them on `/school/standards` (pick "North American Division (Adventist)").

Until then a school can make its own NAD-aligned set (by hand or CSV) on `/school/standards`.
