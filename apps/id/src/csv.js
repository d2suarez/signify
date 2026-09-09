// ===================================================================
// Signify ID — CSV parsing for roster imports
//
// Hand-written rather than a dependency, because the awkward parts here are
// not the grammar — they are what a school office actually exports. Excel
// leads with a UTF-8 byte-order mark, uses CRLF, quotes fields unpredictably,
// and staff rename the headings. All of that is handled below.
// ===================================================================

// RFC 4180, plus the tolerances real files need: CRLF or LF, a trailing
// newline, and quotes appearing mid-field.
function parse(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // Excel's byte-order mark

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }

    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }

    field += c; i += 1;
  }

  // Whatever is left when the text runs out is the last field.
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // Drop rows that are entirely empty — a trailing newline produces one, and
  // so does a blank separator line someone left in the middle.
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// Headings vary: "First Name", "first_name", "firstname", "Given name".
// Normalise to a comparable key rather than demanding an exact spelling.
const normalise = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADER_ALIASES = {
  first_name: ['firstname', 'first', 'givenname', 'given', 'forename', 'legalfirstname'],
  last_name: ['lastname', 'last', 'familyname', 'family', 'surname', 'legallastname'],
  email: ['email', 'emailaddress', 'schoolemail', 'mail', 'username', 'googleaccount'],
  role: ['role', 'usertype', 'type', 'position'],
  tenant: ['schoolid', 'school', 'tenant', 'tenantid', 'site', 'campus'],
  classes: ['classes', 'class', 'classlist', 'sections', 'section', 'courses', 'course', 'homeroom'],
  apps: ['apps', 'app', 'applications', 'application', 'tools', 'access'],
  graduation_year: ['graduationyear', 'gradyear', 'classof', 'cohort', 'yearofgraduation'],
  grade_level: ['gradelevel', 'grade', 'yeargroup', 'year', 'yr'],
};

// Builds { canonicalName: columnIndex } from the header row.
function mapHeaders(headerRow) {
  const seen = headerRow.map(normalise);
  const map = {};
  const unknown = [];

  seen.forEach((h, idx) => {
    if (!h) return;
    let matched = null;
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(h)) { matched = canonical; break; }
    }
    if (matched) {
      // First occurrence wins, so a duplicated column cannot silently
      // shadow the one the person meant.
      if (!(matched in map)) map[matched] = idx;
    } else {
      unknown.push(headerRow[idx]);
    }
  });

  return { map, unknown };
}

// Multi-value cells: "3B Maths; 4A Geography" or comma separated.
function splitList(value) {
  return String(value || '')
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const TEMPLATE_HEADERS = [
  'First name', 'Last name', 'Email address', 'Role',
  'School ID', 'Classes', 'Apps', 'Graduation year',
];

// The file handed out by the console's "Download template" button. Real-looking
// rows beat empty ones — people copy the shape of what they see.
function template() {
  const rows = [
    TEMPLATE_HEADERS,
    // One class, one app, nothing unusual.
    ['Ada', 'Fielding', 'ada@school.edu', 'student', '', '3B Mathematics', '', '2035'],
    // Several classes and several apps: separate them with a semicolon.
    ['Ben', 'Okafor', 'ben@school.edu', 'student', '',
     '3B Mathematics; 4A Geography', 'Classroom Atlas; Classroom Whiteboard', '2035'],
    // Blank columns are fine. School ID can always be left empty.
    ['Priya', 'Hall', 'p.hall@school.edu', 'teacher', '', '3B Mathematics', '', ''],
  ];
  return rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

function escapeCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { parse, mapHeaders, splitList, normalise, template, escapeCell, TEMPLATE_HEADERS, HEADER_ALIASES };
