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

/** Each library set. `raw` names the downloaded file(s) in rawDir. */
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
    key: "va-sol-math", kind: "case", raw: "aa7ab56a-276b-11ef-8aff-0242ac140003",
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
    key: "va-sol-english", kind: "case", raw: "5a36e172-2802-11ef-ae34-0242ac1d0003",
    title: "English Standards of Learning for Virginia Public Schools", version: "2024", subject: ["English Language Arts"],
    publisher: "Virginia Department of Education", creator: "Virginia Board of Education",
    dataSource: "CASE package published on OpenSALT by Virtual Virginia",
    licenseTitle: "© Commonwealth of Virginia, Virginia Department of Education. All rights reserved.",
    licenseURI: "https://www.doe.virginia.gov/teaching-learning-assessment/k-12-standards-instruction/english-reading-literacy",
    licenseText: "Reproduction for instructional purposes in public school classrooms in Virginia is permitted. Any other use needs the Virginia Department of Education's permission.",
    notice: "© 2024 Commonwealth of Virginia Department of Education.",
    distribution: "school",
  },
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
    .replace(/\s+/g, " ").trim()
  : "");
const uuid = (hex) => {
  const h = String(hex).replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
};

// ---------- fetch ----------

async function fetchAll(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of SOURCES) {
    for (const r of [s.raw].flat()) {
      const url = (s.kind === "case" ? OPENSALT : CSP) + r;
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
      officialSourceURL: src.officialSourceURL ?? doc.officialSourceURL ?? null, language: doc.language || "en",
      adoptionStatus: doc.adoptionStatus ?? null, sourceUpdated: doc.lastChangeDateTime ?? null,
      dataURL: OPENSALT + src.raw,
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
    key: src.key, title: src.title, version: src.version, subject: src.subject, publisher: src.publisher,
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
