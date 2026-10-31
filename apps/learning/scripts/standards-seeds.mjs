#!/usr/bin/env node
/**
 * Builds the standards library's seed files (standards/<key>@<version>.json)
 * from published, machine-readable sources. Run by hand when a source
 * changes; the seed files are committed and loaded by src/lib/standards-library.ts.
 *
 *   node scripts/standards-seeds.mjs --fetch <rawDir>   download the sources into rawDir
 *   node scripts/standards-seeds.mjs <rawDir>           write standards/*.json from rawDir
 *
 * Every source, its license and why it may be used: PLAN.md ("Standards
 * library sources") and each seed's "framework" block. Only public files
 * are fetched; nothing here talks to a school system.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "standards");
const OPENSALT = "https://opensalt.net/ims/case/v1p0/CFPackages/";
// States' own CASE servers.
const GEORGIA = "https://case.georgiastandards.org/ims/case/v1p0/CFPackages/";
const CPALMS = "https://www.cpalms.org/Public/ims/case/v1p1/CFPackages/";
const CSP = "https://api.commonstandardsproject.com/api/v1/standard_sets/";

const CCSS_NOTICE = "© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School Officers. All rights reserved.";
const CCSS_LICENSE = {
  licenseTitle: "Common Core State Standards Public License",
  licenseURI: "https://www.thecorestandards.org/public-license/",
  licenseText: "A limited, non-exclusive, royalty-free license to copy, publish, distribute and display the Common Core State Standards for purposes that support the Common Core State Standards Initiative. Any publication or public display must include the copyright notice. NGA Center/CCSSO are acknowledged as the sole owners and developers of the Standards. Covers the 2010 Standards only, not later versions.",
  notice: CCSS_NOTICE,
  distribution: "open",
};

const CSP_ELA_SETS = ["grade-k", "grade-01", "grade-02", "grade-03", "grade-04", "grade-05", "grade-06", "grade-07", "grade-08", "grades-09-10", "grades-11-12"]
  .map((g) => `67810E9EF6944F9383DCC602A3484C23_D10003FC_${g}`);

// State sets whose files state no license: the agency's copyright, and no
// clear permission for a product that is sold, so a school turns them on.
const stateTerms = (agency, page) => ({
  licenseTitle: `© ${agency}. No license stated with the published standards.`,
  licenseURI: page,
  licenseText: `Published by the ${agency} for its schools. Neither the CASE file nor the agency's standards pages state terms for other schools or for a product that is sold; ask the agency before using these outside that state's public schools.`,
  notice: `© ${agency}.`,
  distribution: "school",
});
const GEORGIA_TERMS = (licenseURI) => ({
  licenseTitle: "Creative Commons Attribution-NonCommercial-ShareAlike (CC BY-NC-SA)",
  licenseURI,
  licenseText: "This license allows reusers to distribute, remix, adapt, and build upon the material in any medium or format for noncommercial purposes only, and only so long as attribution is given to the creator. If you remix, adapt, or build upon the material, you must license the modified material under identical terms. (The license named in the Georgia Department of Education's CASE file.)",
  notice: "Georgia Standards © Georgia Department of Education, licensed CC BY-NC-SA.",
  distribution: "school",
});
const CPALMS_TERMS = {
  licenseTitle: "CPALMS License",
  licenseURI: "https://www.cpalms.org/terms/terms.aspx",
  licenseText: "CPALMS standards and course descriptions may be duplicated and reproduced in accordance with Florida's public records laws. © Florida State University; CPALMS is a trademark of Florida State University. (The license in CPALMS's CASE file; the full terms page did not state terms for a product that is sold.)",
  notice: "Florida's B.E.S.T. Standards from CPALMS, the State of Florida's official source for standards. © Florida State University. CPALMS is a trademark of Florida State University.",
  distribution: "school",
};

/**
 * Each library set. `raw` names the downloaded file(s) in rawDir; `url` is
 * where a CASE package comes from (default OpenSALT + raw). `jurisdiction`
 * is the US state's postal code (or 'NAD' for the North American Division's
 * Adventist standards); none for multi-state sets like Common Core.
 */
const SOURCES = [
  {
    key: "ccss-math", kind: "case", raw: "c6496676-d7cb-11e8-824f-0242ac160002",
    title: "Common Core State Standards for Mathematics", version: "2010", subject: ["Mathematics"],
    publisher: "NGA Center and CCSSO",
    dataSource: "CASE package (identifiers from the 1EdTech CASE Network), published on OpenSALT by PCG",
    ...CCSS_LICENSE,
  },
  {
    key: "ccss-ela", kind: "csp", raw: CSP_ELA_SETS,
    title: "Common Core State Standards for English Language Arts & Literacy in History/Social Studies, Science, and Technical Subjects",
    version: "2010", subject: ["English Language Arts"], publisher: "NGA Center and CCSSO", creator: "CCSSO",
    officialSourceURL: "https://www.thecorestandards.org/ELA-Literacy/",
    dataSource: "Achievement Standards Network (D2L, CC BY 3.0 US) via the Common Standards Project; item ids are the official CCSS GUIDs where given",
    ...CCSS_LICENSE,
  },
  {
    key: "ngss", kind: "case", raw: "c608881b-d7cb-11e8-824f-0242ac160002",
    title: "Next Generation Science Standards", version: "2013", subject: ["Science"], publisher: "NGSS Lead States (Achieve, Inc.)",
    dataSource: "CASE package published on OpenSALT by PCG",
    collapse: /^Students who demonstrate understanding can:?$/i,
    licenseTitle: "NGSS Public License (states, districts, schools, teachers and non-profit education entities)",
    licenseURI: "https://www.nextgenscience.org/trademark-and-copyright-guidelines",
    licenseText: "States, districts, schools, teachers and non-profit education entities may copy, reproduce, alter, adapt, edit, delete and rearrange any and all parts of the NGSS without permission. Copyright is held by the National Academies Press. Commercial use of the NGSS marks needs WestEd's approval.",
    notice: "NGSS Lead States. 2013. Next Generation Science Standards: For States, By States. Washington, DC: The National Academies Press. Next Generation Science Standards* and NGSS* are registered trademarks of WestEd. Neither WestEd nor the lead states and partners that developed the Next Generation Science Standards were involved in the production of this product, and do not endorse it.",
    distribution: "school",
  },
  {
    key: "va-sol-math", kind: "case", raw: "aa7ab56a-276b-11ef-8aff-0242ac140003", jurisdiction: "VA",
    title: "Mathematics Standards of Learning for Virginia Public Schools", version: "2023", subject: ["Mathematics"],
    publisher: "Virginia Department of Education", creator: "Virginia Board of Education",
    dataSource: "CASE package published on OpenSALT by Virtual Virginia",
    licenseTitle: "© Commonwealth of Virginia, Virginia Department of Education. All rights reserved.",
    licenseURI: "https://www.doe.virginia.gov/teaching-learning-assessment/k-12-standards-instruction/mathematics",
    licenseText: "Reproduction for instructional purposes in public school classrooms in Virginia is permitted. Any other use needs the Virginia Department of Education's permission.",
    notice: "© 2023 Commonwealth of Virginia Department of Education.",
    distribution: "school",
  },
  {
    key: "va-sol-english", kind: "case", raw: "5a36e172-2802-11ef-ae34-0242ac1d0003", jurisdiction: "VA",
    title: "English Standards of Learning for Virginia Public Schools", version: "2024", subject: ["English Language Arts"],
    publisher: "Virginia Department of Education", creator: "Virginia Board of Education",
    dataSource: "CASE package published on OpenSALT by Virtual Virginia",
    licenseTitle: "© Commonwealth of Virginia, Virginia Department of Education. All rights reserved.",
    licenseURI: "https://www.doe.virginia.gov/teaching-learning-assessment/k-12-standards-instruction/english-reading-literacy",
    licenseText: "Reproduction for instructional purposes in public school classrooms in Virginia is permitted. Any other use needs the Virginia Department of Education's permission.",
    notice: "© 2024 Commonwealth of Virginia Department of Education.",
    distribution: "school",
  },
  {
    key: "ga-math", kind: "case", raw: "e9dd7229-3558-4df2-85c6-57b8938f6180", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia's K-12 Mathematics Standards", version: "2023", subject: ["Mathematics"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    officialSourceURL: "https://www.gadoe.org/Curriculum-Instruction-and-Assessment/Curriculum-and-Instruction/Pages/Mathematics.aspx",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (implemented 2023-2024)",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/2f22abe2-eb0a-415f-8b45-a13859b35aca"),
  },
  {
    key: "ga-ela", kind: "case", raw: "391c3abe-c1ec-4a4a-a942-c9e152b35102", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia's K-12 Standards for English Language Arts", version: "2025", subject: ["English Language Arts"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (implemented 2025-2026)",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/ims/case/v1p0/CFLicenses/d882a8cd-deb9-41bc-8567-1df270735af6"),
  },
  {
    key: "ga-science", kind: "case", raw: "27a08dc6-416e-11e7-ba71-02bd89fdd987", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Science", version: "2016", subject: ["Science"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (K-12 approved 2016; more high school courses 2019)",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/47df204e-0584-4a22-b8d7-2ff0b686d989"),
  },
  {
    key: "ga-social-studies", kind: "case", raw: "a446e74c-463e-11e7-94f5-b49cee8b2d8c", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Social Studies", version: "2021", subject: ["Social Studies"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (courses marked Deprecated left out)",
    skipType: /^Deprecated$/i,
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/ee8eb90e-91df-414f-a247-6ab09d217031"),
  },
  {
    key: "fl-best-math", kind: "case", raw: "56a98ac7-85fd-42d2-9756-ef5ce6a71de3", url: CPALMS, jurisdiction: "FL",
    title: "Florida's B.E.S.T. Standards for Mathematics", version: "2020", subject: ["Mathematics"],
    publisher: "Florida Department of Education", creator: "Florida Department of Education",
    officialSourceURL: "https://www.cpalms.org/Public/search/Standard",
    dataSource: "CASE package from CPALMS's CASE server (Florida State University for the Florida Department of Education)",
    ...CPALMS_TERMS,
  },
  {
    key: "fl-best-ela", kind: "case", raw: "57a98ac7-85fd-42d2-9756-ef5ce6a71de3", url: CPALMS, jurisdiction: "FL",
    title: "Florida's B.E.S.T. Standards for English Language Arts", version: "2020", subject: ["English Language Arts"],
    publisher: "Florida Department of Education", creator: "Florida Department of Education",
    officialSourceURL: "https://www.cpalms.org/Public/search/Standard",
    dataSource: "CASE package from CPALMS's CASE server (Florida State University for the Florida Department of Education)",
    ...CPALMS_TERMS,
  },
  {
    key: "ok-math", kind: "case", raw: "18f39bc2-ca90-11ed-998f-0242ac160003", jurisdiction: "OK",
    title: "Oklahoma Academic Standards for Mathematics", version: "2022", subject: ["Mathematics"],
    publisher: "Oklahoma State Department of Education",
    dataSource: "CASE package published on OpenSALT by the Oklahoma State Department of Education (Adopted)",
    ...stateTerms("Oklahoma State Department of Education", "https://sde.ok.gov/oklahoma-academic-standards"),
  },
  {
    key: "md-math", kind: "case", raw: "5254fd3f-b10b-5aae-95b0-ce4cf3223874", jurisdiction: "MD",
    title: "Maryland College and Career Ready Standards for Mathematics", version: "2025", subject: ["Mathematics"],
    publisher: "Maryland State Department of Education",
    dataSource: "CASE package published on OpenSALT for the Maryland State Department of Education by PCG (Adopted)",
    ...stateTerms("Maryland State Department of Education", "https://marylandpublicschools.org/about/pages/dcaa/math/revised-standards.aspx"),
  },
  {
    key: "in-math", kind: "case", raw: "76673c2e-5cb6-11ee-a3bc-0242c0a84002", jurisdiction: "IN",
    title: "Indiana Academic Standards for Mathematics", version: "2023", subject: ["Mathematics"],
    publisher: "Indiana Department of Education",
    dataSource: "CASE package published on OpenSALT by the Indiana Department of Education (marked Draft there; the 2023 standards are Indiana's current ones)",
    ...stateTerms("Indiana Department of Education", "https://www.in.gov/doe/students/indiana-academic-standards/mathematics/"),
  },
  // NAD (North American Division) Adventist standards: not added. The NAD's
  // content is copyrighted and published only as PDFs. Once the NAD Office of
  // Education gives written permission and a spreadsheet or CASE file, add one
  // entry per subject here, e.g.
  //   { key: "nad-math", kind: "case" | "csv", raw: "<file>", jurisdiction: "NAD",
  //     title: "NAD Mathematics Standards", version: "<year>", subject: ["Mathematics"],
  //     publisher: "North American Division Office of Education", licenseTitle: "<the permission>",
  //     licenseURI, licenseText, notice, distribution: "school" }
  // (a spreadsheet needs a small reader like fromCsp). See standards/README.md.
];

const GRADES = ["PK", "KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const grade = (g) => {
  const s = String(g).toUpperCase().replace(/^K$/, "KG").replace(/^(\d)$/, "0$1");
  return GRADES.includes(s) ? s : null;
};
const grades = (list) => [...new Set((list ?? []).map(grade).filter(Boolean))].sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b));
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Plain text: standards are stored and shown as text, never HTML. */
const clean = (s) => (typeof s === "string"
  ? s.replace(/<[^>]*>/g, "").replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\*\*/g, "").replace(/\s+/g, " ").trim()
  : "");
/** 'eng', 'en_US' → 'en'. */
const lang = (l) => String(l || "en").toLowerCase().replace(/^eng$/, "en").split(/[-_]/)[0];
const uuid = (hex) => {
  const h = String(hex).replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
};

// ---------- fetch ----------

const caseUrl = (s) => (s.url ?? OPENSALT) + s.raw + (s.url === CPALMS ? ".json" : "");

async function fetchAll(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of SOURCES) {
    for (const r of [s.raw].flat()) {
      const url = s.kind === "case" ? caseUrl(s) : CSP + r;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      fs.writeFileSync(path.join(dir, `${r}.json`), Buffer.from(await res.arrayBuffer()));
      console.log("fetched", url);
    }
  }
}

// ---------- CASE packages ----------

function fromCase(src, pkg) {
  const doc = pkg.CFDocument;
  const byId = new Map(pkg.CFItems.map((i) => [i.identifier, i]));
  const kids = new Map();
  const other = [];
  for (const a of pkg.CFAssociations ?? []) {
    if (a.associationType === "isChildOf") {
      const p = a.destinationNodeURI.identifier;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push({ seq: a.sequenceNumber ?? Number.MAX_SAFE_INTEGER, id: a.originNodeURI.identifier });
    } else other.push(a);
  }
  const items = [];
  const seen = new Set();
  const walk = (parentId, outParent) => {
    for (const k of (kids.get(parentId) ?? []).sort((a, b) => a.seq - b.seq)) {
      const i = byId.get(k.id);
      if (!i || seen.has(i.identifier)) continue;
      seen.add(i.identifier);
      if (src.skipType?.test(i.CFItemType ?? "")) continue;
      const statement = clean(i.fullStatement);
      // Connector nodes ("Students who demonstrate understanding can:") add nothing: their children move up.
      if (src.collapse && !i.humanCodingScheme && src.collapse.test(statement)) { walk(i.identifier, outParent); continue; }
      items.push({
        identifier: i.identifier, uri: i.uri ?? null, code: clean(i.humanCodingScheme), statement,
        abbreviated: clean(i.abbreviatedStatement) || null, type: clean(i.CFItemType) || null,
        grades: grades(i.educationLevel), parent: outParent, list: clean(i.listEnumeration) || null, notes: clean(i.notes) || null,
      });
      walk(i.identifier, i.identifier);
    }
  };
  walk(doc.identifier, null);
  const kept = new Set(items.map((i) => i.identifier));
  const associations = other
    .filter((a) => kept.has(a.originNodeURI.identifier))
    .map((a) => ({ origin: a.originNodeURI.identifier, type: a.associationType, dest: a.destinationNodeURI.identifier, destUri: a.destinationNodeURI.uri ?? null }));
  return {
    framework: {
      identifier: doc.identifier, uri: doc.uri ?? null, creator: src.creator ?? clean(doc.creator),
      officialSourceURL: src.officialSourceURL ?? doc.officialSourceURL ?? null, language: lang(doc.language),
      adoptionStatus: doc.adoptionStatus ?? null, sourceUpdated: doc.lastChangeDateTime ?? null,
      dataURL: caseUrl(src),
    },
    items, associations,
  };
}

// ---------- Common Standards Project sets (ASN) ----------

function fromCsp(src, sets) {
  const items = [];
  const byKey = new Map();
  const ANCHORS = "ccra";
  items.push({ identifier: null, key: ANCHORS, code: "CCRA", statement: "College and Career Readiness Anchor Standards", type: "Anchor Standards", grades: [], parent: null });
  for (const set of sets) {
    const lv = grades(set.educationLevels);
    const gradeKey = `grade:${lv.join("-")}`;
    items.push({ identifier: null, key: gradeKey, code: "", statement: lv.length === 1 ? (lv[0] === "KG" ? "Kindergarten" : `Grade ${Number(lv[0])}`) : `Grades ${lv.map(Number).join("–")}`, type: "Grade Level", grades: lv, parent: null });
    const list = Object.values(set.standards).sort((a, b) => a.position - b.position);
    const anchorRoots = new Set(list.filter((s) => s.depth === 0 && /^College and Career Readiness Anchor/i.test(s.description)).map((s) => s.id));
    for (const s of list) {
      const inAnchors = anchorRoots.has(s.id) || (s.ancestorIds ?? []).some((a) => anchorRoots.has(a));
      const match = (s.exactMatch ?? []).find((m) => !String(m).startsWith("http"));
      const key = s.statementNotation || s.id;
      const prev = byKey.get(key);
      if (prev) { prev.grades = grades([...prev.grades, ...lv]); continue; }
      const code = clean(s.altStatementNotation) || clean(s.statementNotation).replace(/^CCSS\.ELA-Literacy\./, "");
      const item = {
        identifier: uuid(match ?? s.id), key,
        uri: (s.exactMatch ?? []).find((m) => String(m).startsWith("http")) ?? null,
        code, statement: clean(s.description), abbreviated: null, type: clean(s.statementLabel) || null,
        grades: lv,
        parentKey: s.parentId ? (list.find((p) => p.id === s.parentId)?.statementNotation || s.parentId) : (inAnchors ? ANCHORS : gradeKey),
        list: clean(s.listId) || null, notes: (s.comments ?? []).map(clean).join(" ") || null,
      };
      byKey.set(key, item);
      items.push(item);
    }
  }
  // Grade and anchor headers get stable made-up identifiers (no official id exists).
  const keyToId = new Map();
  for (const i of items) {
    if (!i.identifier) i.identifier = stableUuid(`${src.key}:${i.key}`);
    keyToId.set(i.key, i.identifier);
  }
  for (const i of items) {
    i.parent = i.parentKey ? keyToId.get(i.parentKey) ?? null : null;
    delete i.parentKey; delete i.key;
    i.uri ??= null; i.abbreviated ??= null; i.list ??= null; i.notes ??= null;
  }
  // Anchors first, then each grade in order.
  return {
    framework: {
      // No official CASE document id is public for CCSS ELA: a stable made-up one.
      identifier: stableUuid(`${src.key}:document`), uri: null, creator: src.creator,
      officialSourceURL: src.officialSourceURL, language: "en", adoptionStatus: "Adopted", sourceUpdated: null,
      dataURL: CSP + src.raw[0].replace(/grade-k$/, "*"),
    },
    items: sortTree(items), associations: [],
  };
}

/** Parents before their children, siblings in their first order. */
function sortTree(items) {
  const kids = new Map();
  for (const i of items) { const p = i.parent ?? ""; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(i); }
  const out = [];
  const walk = (p) => { for (const i of kids.get(p) ?? []) { out.push(i); walk(i.identifier); } };
  walk("");
  return out;
}

function stableUuid(s) {
  const h = crypto.createHash("sha1").update(s).digest("hex");
  return uuid(h.slice(0, 12) + "5" + h.slice(13, 16) + "8" + h.slice(17, 32));
}

// ---------- write ----------

function write(src, built) {
  const fw = {
    key: src.key, title: src.title, version: src.version, subject: src.subject, publisher: src.publisher, jurisdiction: src.jurisdiction ?? null,
    ...built.framework,
    dataSource: src.dataSource, licenseTitle: src.licenseTitle, licenseURI: src.licenseURI, licenseText: src.licenseText,
    notice: src.notice, distribution: src.distribution,
  };
  const ids = new Set();
  for (const i of built.items) {
    if (ids.has(i.identifier)) throw new Error(`${src.key}: duplicate ${i.identifier}`);
    ids.add(i.identifier);
    if (i.parent && !ids.has(i.parent)) throw new Error(`${src.key}: ${i.identifier} before its parent`);
  }
  const file = path.join(OUT, `${src.key}@${src.version}.json`);
  // One item per line, so a source update reads as a diff.
  const lines = [
    "{",
    `"format": "signify-standards/1",`,
    `"framework": ${JSON.stringify(fw)},`,
    `"items": [`,
    built.items.map((i) => JSON.stringify(i)).join(",\n"),
    `],`,
    `"associations": [`,
    built.associations.map((a) => JSON.stringify(a)).join(",\n"),
    `]`,
    "}",
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log(`${path.basename(file)}: ${built.items.length} items, ${built.associations.length} associations`);
}

const args = process.argv.slice(2);
if (args[0] === "--fetch") {
  await fetchAll(args[1]);
} else if (args[0]) {
  fs.mkdirSync(OUT, { recursive: true });
  const read = (r) => JSON.parse(fs.readFileSync(path.join(args[0], `${r}.json`), "utf8"));
  for (const s of SOURCES) {
    write(s, s.kind === "case" ? fromCase(s, read(s.raw)) : fromCsp(s, s.raw.map((r) => read(r).data)));
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(SOURCES.map((s) => `${s.key}@${s.version}.json`), null, 2) + "\n");
} else {
  console.error("usage: standards-seeds.mjs --fetch <rawDir> | <rawDir>");
  process.exit(1);
}
