#!/usr/bin/env node
/**
 * Builds the standards library's seed files (standards/<key>@<version>.json)
 * from published, machine-readable sources. Run by hand when a source
 * changes; the seed files are committed and loaded by src/lib/standards-library.ts.
 *
 *   node scripts/standards-seeds.mjs --fetch <rawDir>   download the sources into rawDir
 *   node scripts/standards-seeds.mjs <rawDir>           write standards/*.json from rawDir
 *   ... --only nad-                                      just the NAD sets (needs pdfjs-dist, see nad-standards.mjs)
 *
 * Every source, its license and why it may be used: PLAN.md ("Standards
 * library sources") and each seed's "framework" block. Only public files
 * are fetched; nothing here talks to a school system.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAD_PDFS, codesIn, fetchNad, parseGrid, parseOutline, parseTech } from "./nad-standards.mjs";

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

// NAD (North American Division, Seventh-day Adventist) Office of Education
// standards: published only as PDFs, read by scripts/nad-standards.mjs.
// Added on Desmond's go-ahead (2026-10-31) for Richmond Academy, an NAD school;
// each school turns them on itself and accepts the NAD's terms.
const NAD_TERMS = (page) => ({
  licenseTitle: "© North American Division Office of Education, Seventh-day Adventist Church. All content is copyrighted and may not be used without permission.",
  licenseURI: "https://adventisteducation.org/use-and-privacy-policy",
  licenseText: `Published by the NAD Office of Education for Seventh-day Adventist schools (${page}). The NAD's site says: "Distribution and use of these documents is subject to the terms outlined in our use and privacy policies. All content is copyrighted and may not be used without permission." A school that turns these on accepts those terms; ask the NAD Office of Education before using them outside NAD schools.`,
  notice: "Standards © North American Division Office of Education, Seventh-day Adventist Church. All content is copyrighted and may not be used without permission.",
  distribution: "school",
});
const NAD_ELEM = "https://adventisteducation.org/elementary-standards";
const NAD_SEC = "https://adventisteducation.org/secondary-standards";
const K8 = ["KG", "01", "02", "03", "04", "05", "06", "07", "08"];
const HS = ["09", "10", "11", "12"];
// Elementary codes: <prefix>.<grade or band>.<domain>.<n>, e.g. B.1-4.BF.16, LA.3.RI.2.
const nadCode = (prefix) => new RegExp(`^${prefix}\\.\\s?(?:K|\\d{1,2})(?:\\s?[-–]\\s?\\d{1,2})?\\s?\\.\\s?[A-Z]{1,4}\\s?\\.\\s?\\d+`);
const NAD_GRID = { grade: /^(?:[A-Z]+\.)?((?:K|\d+)(?:-\d+)?)\./, domain: /\.([A-Z]+)\.\d+$/ };
// Secondary codes: ACCT.1, ACCT.1.1, BIO1.2.3, LA.9.1.1.
const NAD_OUTLINE = /^[A-Z&]{1,5}\d?(?:\.(?:\d{1,2}-)?\d+){1,3}\b/;
const nad = (key, version, title, subject, raw, layout, opts, page = NAD_ELEM) => ({
  key, kind: "nad", raw: [raw], layout, opts, jurisdiction: "NAD", title, version, subject,
  publisher: "North American Division Office of Education, Seventh-day Adventist Church",
  creator: "North American Division Office of Education",
  officialSourceURL: page,
  dataSource: `Read from the NAD's PDF (${raw}) by scripts/nad-standards.mjs: codes and statements as printed, placed by their position on the page`,
  ...NAD_TERMS(page),
});
// The grade-level PDFs reprint the elementary codes by grade; the build checks against them.
const NAD_GRADE_PDFS = ["K", 1, 2, 3, 4, 5, 6, 7, 8].map((g) => `${g}-Elementary-Standards-by-Grade-Level-Grade-${g}.pdf`);

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
  {
    key: "fl-science", kind: "case", raw: "1da98ac7-85fd-42d2-9756-ef5ce6a71de3", url: CPALMS, jurisdiction: "FL",
    title: "Florida's Next Generation Sunshine State Standards for Science", version: "2008", subject: ["Science"],
    publisher: "Florida Department of Education", creator: "Florida Department of Education",
    officialSourceURL: "https://www.cpalms.org/Public/search/Standard",
    dataSource: "CASE package from CPALMS's CASE server (Florida State University for the Florida Department of Education)",
    ...CPALMS_TERMS,
  },
  {
    key: "fl-social-studies", kind: "case", raw: "20a98ac7-85fd-42d2-9756-ef5ce6a71de3", url: CPALMS, jurisdiction: "FL",
    title: "Florida's Next Generation Sunshine State Standards for Social Studies", version: "2008", subject: ["Social Studies"],
    publisher: "Florida Department of Education", creator: "Florida Department of Education",
    officialSourceURL: "https://www.cpalms.org/Public/search/Standard",
    dataSource: "CASE package from CPALMS's CASE server (Florida State University for the Florida Department of Education); first adopted 2008, with the state's later revisions as CPALMS publishes them",
    ...CPALMS_TERMS,
  },
  {
    key: "ga-dance", kind: "case", raw: "0648186e-9c0e-11e8-93e0-297d326f2fb2", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Dance", version: "2017", subject: ["Dance"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/7b90fa24-b1c8-42e1-9b14-0ccb02bb33ab"),
  },
  {
    key: "ga-music", kind: "case", raw: "f3b94c72-9c0d-11e8-b85c-3b1a3079ae6e", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Music", version: "2017", subject: ["Music"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/7b90fa24-b1c8-42e1-9b14-0ccb02bb33ab"),
  },
  {
    key: "ga-theatre", kind: "case", raw: "fb9f79de-9c0d-11e8-b8aa-d191c40f5ec5", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Dramatic Arts/Theatre", version: "2017", subject: ["Theatre"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/7b90fa24-b1c8-42e1-9b14-0ccb02bb33ab"),
  },
  {
    key: "ga-visual-art", kind: "case", raw: "ed489b90-9c0d-11e8-872d-1f5e8db2771f", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Visual Art", version: "2017", subject: ["Visual Art"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/7b90fa24-b1c8-42e1-9b14-0ccb02bb33ab"),
  },
  {
    key: "ga-health", kind: "case", raw: "d1a06ea7-6d53-4df5-982b-5cbe38cd2ad7", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Health", version: "2021", subject: ["Health"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (implemented 2022-2023)",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/663ebf53-d400-4c92-b111-8a589028c882"),
  },
  {
    key: "ga-pe", kind: "case", raw: "d79f5948-e166-11e8-8ec3-0242ac150004", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Physical Education", version: "2018", subject: ["Physical Education"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (approved May 2018, implemented 2019-2020)",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/21854649-4436-4f06-98c9-a983d665656e"),
  },
  {
    key: "ga-computer-science", kind: "case", raw: "00fcf0e2-b9c3-11e7-a4ad-47f36833e889", url: GEORGIA, jurisdiction: "GA",
    title: "Georgia Standards of Excellence for Computer Science", version: "2019", subject: ["Computer Science"],
    publisher: "Georgia Department of Education", creator: "Georgia Department of Education",
    dataSource: "CASE package from the Georgia Department of Education's CASE server (K-8 adopted 2019, with the high school courses)",
    ...GEORGIA_TERMS("https://case.georgiastandards.org/uri/8f7703e4-8fb6-4ba8-a311-44de60e4d746"),
  },
  nad("nad-bible-elementary", "2017", "NAD Elementary Bible Standards", ["Bible"], "Elementary-Bible-Standards.pdf", "grid", { code: nadCode("B"), ...NAD_GRID }),
  nad("nad-ela-elementary", "2013", "NAD Elementary English Language Arts Standards", ["English Language Arts"], "ElementaryLanguageArtsStandards.pdf", "grid", { code: nadCode("LA"), ...NAD_GRID }),
  nad("nad-math-elementary", "2012", "NAD Elementary Mathematics Standards", ["Mathematics"], "Elementary-Math-Standards.pdf", "grid", {
    code: /^(?:K|\d)\.\s?[A-Z](?:\s?[A-Z]){0,3}\.\s?\d+/, ...NAD_GRID, cutX: 455, corr: /^(Chapter|Section|Topic)\b/, skipRows: /^Assessments$/,
    misprints: { "28.OAT.2": "8.OAT.2" },
  }),
  nad("nad-science-elementary", "2015", "NAD Elementary Science Standards", ["Science"], "Elementary-Science-Standards.pdf", "grid", { code: nadCode("S"), ...NAD_GRID, corr: /^(Level \d|Ch\.|These performance)/ }),
  nad("nad-social-studies-elementary", "2016", "NAD Elementary Social Studies Standards", ["Social Studies"], "Elementary-Social-Studies-Standards.pdf", "grid", { code: nadCode("SS"), ...NAD_GRID, cutX: 280, align: "middle" }),
  nad("nad-fine-arts-elementary", "2017", "NAD Elementary Fine Arts Standards", ["Fine Arts"], "Elementary-Fine-Arts-Standards.pdf", "grid", {
    code: nadCode("FA"), ...NAD_GRID, misprints: { "FA.1.4.M.15": "FA.1-4.M.15" },
  }),
  nad("nad-pe-elementary", "2016", "NAD Elementary Physical Education Standards", ["Physical Education"], "Elementary-PE-Standards.pdf", "grid", { code: nadCode("PE"), ...NAD_GRID }),
  nad("nad-technology-elementary", "2022", "NAD Elementary Technology Standards", ["Technology"], "2022NADElementaryTechnologyStandardsDocument_0823.pdf", "tech", { grades: K8 }),
  nad("nad-ela-secondary", "2017", "NAD Secondary Language Arts Standards", ["English Language Arts"], "Secondary-Language-Arts-Standards-Complete-Set.pdf", "outline", {
    code: NAD_OUTLINE, defaultGrades: HS, grades: { "Grade Nine": ["09"], "Grade Ten": ["10"], "Grade Eleven": ["11"], "Grade Twelve": ["12"] },
    misprints: { "LA.10.1 1": "LA.10.1.1" },
  }, NAD_SEC),
  nad("nad-math-secondary", "2018", "NAD Secondary Mathematics Standards", ["Mathematics"], "Secondary-Mathematics-Standards-Complete-Set.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
  nad("nad-science-secondary", "2019", "NAD Secondary Science Standards", ["Science"], "Secondary-Science-Standards-Complete-Set.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
  nad("nad-social-studies-secondary", "2018", "NAD Secondary Social Studies Standards", ["Social Studies"], "Secondary-Social-Studies-Standards-Complete-Set.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
  nad("nad-fine-arts-secondary", "2018", "NAD Secondary Fine Arts Standards (Music, Visual Arts)", ["Fine Arts"], "Secondary-Fine-Arts-Standards-Complete-Set.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
  nad("nad-health-pe-secondary", "2019", "NAD Secondary Health and Physical Education Standards", ["Health", "Physical Education"], "Secondary-Health-and-PE-Standards-Complete-Set.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
  nad("nad-technology-secondary", "2018", "NAD Secondary Technology Standards (Cross-Curricular)", ["Technology"], "Secondary-Cross-Curricular-Technology-Education-Standards-Complete-Set.pdf", "outline", {
    code: /^T\.9-12\.[A-Z]{2}\.\d+/, defaultGrades: HS,
  }, NAD_SEC),
  nad("nad-business-secondary", "2018", "NAD Secondary Business Education Standards", ["Business"], "Secondary-Business-Education-Standards-Complete-Set.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
  // The NAD's grades 9-12 Bible course standards (BC.<grade>.<standard>.<indicator>), on the NAD's
  // own hub though the secondary page doesn't link them; the Adventist Learning Community lists them
  // as "NAD Standards for High School Bible Courses Grade 9-Grade 12".
  nad("nad-bible-secondary", "2017", "NAD Secondary Religion Standards (High School Bible Courses)", ["Bible"], "Secondary-Religion-Standards-Complete-Set.pdf", "outline", {
    code: NAD_OUTLINE, defaultGrades: HS,
    grades: { "Bible Course - Grade Nine": ["09"], "Bible Course - Grade Ten": ["10"], "Bible Course - Grade Eleven": ["11"], "Bible Course - Grade Twelve": ["12"] },
  }, NAD_SEC),
  nad("nad-world-languages-secondary", "2018", "NAD Secondary Foreign Language Standards", ["World Languages"], "Secondary-Foreign-Language-1-Standards.pdf", "outline", { code: NAD_OUTLINE, defaultGrades: HS }, NAD_SEC),
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

async function fetchAll(dir, only) {
  fs.mkdirSync(dir, { recursive: true });
  const wanted = SOURCES.filter((s) => !only || s.key.startsWith(only));
  for (const s of wanted) {
    if (s.kind === "nad") { await fetchNad(dir, s.raw); continue; }
    for (const r of [s.raw].flat()) {
      const url = s.kind === "case" ? caseUrl(s) : CSP + r;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      fs.writeFileSync(path.join(dir, `${r}.json`), Buffer.from(await res.arrayBuffer()));
      console.log("fetched", url);
    }
  }
  if (wanted.some((s) => s.kind === "nad")) await fetchNad(dir, NAD_GRADE_PDFS);
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

// ---------- NAD PDFs ----------

async function fromNad(src, dir) {
  const file = path.join(dir, src.raw[0]);
  const parsed = src.layout === "grid" ? await parseGrid(file, src.opts)
    : src.layout === "outline" ? await parseOutline(file, src.opts)
      : await parseTech(file, src.opts);
  for (const p of parsed.problems) console.log(`  ${src.key}: ${p}`);
  const coded = parsed.items.filter((i) => i.code && ["Standard", "Indicator", "Objective"].includes(i.type)).length;
  if (src.layout !== "tech" && coded !== parsed.tokens) throw new Error(`${src.key}: ${parsed.tokens} codes on the pages but ${coded} standards read`);
  const id = new Map(parsed.items.map((i) => [i.key, stableUuid(`${src.key}:${i.key}`)]));
  const items = parsed.items.map((i) => {
    const text = `${i.code} ${i.statement}`;
    // Page furniture must never end up in a statement.
    if (/OFFICE OF EDUCATION|North American Division Seventh-day|ESSENTIAL QUESTION|Essential Question:|Big Idea:/i.test(text)) throw new Error(`${src.key}: ${i.code || i.key} has page header text: ${text.slice(0, 80)}`);
    if (!i.statement) throw new Error(`${src.key}: ${i.code || i.key} has no statement`);
    return {
      identifier: id.get(i.key), uri: null, code: i.code, statement: i.statement, abbreviated: i.abbreviated ?? null, type: i.type,
      grades: i.grades, parent: i.parentKey ? id.get(i.parentKey) : null, list: null, notes: i.notes ?? null,
    };
  });
  return {
    framework: {
      identifier: stableUuid(`${src.key}:document`), uri: null, creator: src.creator, officialSourceURL: src.officialSourceURL,
      language: "en", adoptionStatus: "Adopted", sourceUpdated: null, dataURL: NAD_PDFS + src.raw[0],
    },
    items: sortTree(items), associations: [],
  };
}

/**
 * The elementary sets against the NAD's grade-level PDFs, which reprint them by
 * grade: every code, and the statements word for word. Printed, not thrown:
 * the two editions differ in places and have their own slips.
 */
async function checkNadGrades(dir, built) {
  if (!NAD_GRADE_PDFS.every((f) => fs.existsSync(path.join(dir, f)))) return;
  const ours = new Map(built.flatMap((b) => b.items.filter((i) => i.code.includes(".")).map((i) => [i.code, i.statement])));
  const loose = /^(?:(?:B|LA|S|SS|FA|PE)\.\s?)?(?:K|\d{1,2})(?:\s?[-–]\s?\d{1,2})?\s?\.\s?[A-Z]{1,4}\s?\.\s?\d+/;
  const theirs = new Map();
  for (const f of NAD_GRADE_PDFS) for (const [c, t] of await codesIn(path.join(dir, f), loose)) theirs.set(c, t);
  const missing = [...theirs.keys()].filter((c) => !ours.has(c));
  const extra = [...ours.keys()].filter((c) => !theirs.has(c) && !c.startsWith("T."));
  const letters = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const differ = [...ours].filter(([c, t]) => theirs.has(c) && letters(t) !== letters(theirs.get(c))).map(([c]) => c);
  console.log(`NAD grade-level PDFs: ${theirs.size} codes; not in the subject sets: ${missing.join(" ") || "none"}; not in the grade PDFs: ${extra.join(" ") || "none"}`);
  console.log(`  statements: ${ours.size - extra.length - differ.length} the same letter for letter; differ (check by eye): ${differ.join(" ") || "none"}`);
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

// --only <key prefix> fetches or builds just those sets (e.g. --only nad-); the manifest always lists every set.
const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args.splice(onlyAt, 2)[1] : null;
if (args[0] === "--fetch") {
  await fetchAll(args[1], only);
} else if (args[0]) {
  fs.mkdirSync(OUT, { recursive: true });
  const read = (r) => JSON.parse(fs.readFileSync(path.join(args[0], `${r}.json`), "utf8"));
  const nadBuilt = [];
  for (const s of SOURCES) {
    if (only && !s.key.startsWith(only)) continue;
    const built = s.kind === "case" ? fromCase(s, read(s.raw)) : s.kind === "nad" ? await fromNad(s, args[0]) : fromCsp(s, s.raw.map((r) => read(r).data));
    if (s.kind === "nad" && s.key.endsWith("-elementary")) nadBuilt.push(built);
    write(s, built);
  }
  if (nadBuilt.length) await checkNadGrades(args[0], nadBuilt);
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(SOURCES.map((s) => `${s.key}@${s.version}.json`), null, 2) + "\n");
} else {
  console.error("usage: standards-seeds.mjs --fetch <rawDir> [--only <key prefix>] | <rawDir> [--only <key prefix>]");
  process.exit(1);
}
