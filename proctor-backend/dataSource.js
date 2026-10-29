// Where the roll, admins, tests and questions come from:
//  - Airtable, when AIRTABLE_API_KEY and AIRTABLE_BASE_ID are set
//  - built-in demo data otherwise
// The correct answers stay inside the server. They are never sent to the frontend.
const KEY = process.env.AIRTABLE_API_KEY || "";
const BASE = process.env.AIRTABLE_BASE_ID || "";
const USE_AIRTABLE = !!(KEY && BASE);

const TABLES = {
  roll: process.env.AIRTABLE_TABLE_ROLL || "Roll",
  admins: process.env.AIRTABLE_TABLE_ADMINS || "Admins",
  tests: process.env.AIRTABLE_TABLE_TESTS || "Tests",
  mcqs: process.env.AIRTABLE_TABLE_MCQS || "MCQs",
};
const CACHE_MS = 60 * 1000; // Airtable allows about 5 requests per second, so tables are cached for 60 s

// ---------- demo data (used when Airtable is not connected) ----------
const DEMO = {
  roll: [
    { regNo: "12515001234", name: "Demo Student", email: "demo.student@example.com" },
    { regNo: "12515005678", name: "Student Two", email: "student.two@example.com" },
    { regNo: "12515009999", name: "Student Three", email: "student.three@example.com" },
    { regNo: "12515000000", name: "Test Runner", email: "test.runner@example.com" }, // used by smoke-test.js
  ],
  tests: [{ id: "demo-test", title: "Demo MCQ Test", durationSeconds: 300 }],
  questions: [
    { id: "q1", question: "Which hook is used to manage state in a React function component?", options: ["useEffect", "useState", "useRef", "useMemo"], correctIndex: 1 },
    { id: "q2", question: "Which HTTP method is generally used to create a new resource?", options: ["GET", "PUT", "POST", "DELETE"], correctIndex: 2 },
    { id: "q3", question: "What is the time complexity of binary search?", options: ["O(n)", "O(n log n)", "O(log n)", "O(1)"], correctIndex: 2 },
    { id: "q4", question: "Which of these is NOT a JavaScript data type?", options: ["Number", "Boolean", "Float", "String"], correctIndex: 2 },
    { id: "q5", question: "Which tag is used for the largest heading in HTML?", options: ["<h6>", "<head>", "<h1>", "<heading>"], correctIndex: 2 },
  ],
};
const demoAdmins = () => [
  { email: (process.env.DEMO_ADMIN_EMAIL || "admin@example.com").trim().toLowerCase(), name: "Demo Admin" },
];

// ---------- Airtable access ----------
async function fetchTable(table) {
  const records = [];
  let offset;
  do {
    const url = new URL("https://api.airtable.com/v0/" + BASE + "/" + encodeURIComponent(table));
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: { Authorization: "Bearer " + KEY } });
    if (!res.ok) throw new Error('Airtable table "' + table + '" returned ' + res.status);
    const json = await res.json();
    records.push(...json.records);
    offset = json.offset;
  } while (offset);
  return records;
}

// 60 second cache. Parallel requests share one fetch. If Airtable fails, the old data is served.
const cache = {};
async function cachedTable(table) {
  const c = cache[table] || (cache[table] = { at: 0, data: null, pending: null });
  if (c.data && Date.now() - c.at < CACHE_MS) return c.data;
  if (c.pending) return c.pending;
  c.pending = fetchTable(table)
    .then((rows) => {
      c.data = rows;
      c.at = Date.now();
      return rows;
    })
    .catch((err) => {
      if (c.data) {
        c.at = Date.now() - CACHE_MS + 10000; // try again in 10 seconds
        return c.data;
      }
      throw err;
    })
    .finally(() => {
      c.pending = null;
    });
  return c.pending;
}

// Reads a column by name, ignoring case, spaces and punctuation ("Registration number" = "registration_number")
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
function field(fields, ...names) {
  const keys = Object.keys(fields);
  for (const n of names) {
    const k = keys.find((x) => norm(x) === norm(n));
    if (k !== undefined && fields[k] !== undefined && fields[k] !== null) return fields[k];
  }
  return undefined;
}

// ---------- public functions ----------
async function getRoll() {
  if (!USE_AIRTABLE) return DEMO.roll;
  const rows = await cachedTable(TABLES.roll);
  return rows
    .map((r) => ({
      regNo: String(field(r.fields, "Registration number", "Reg No", "RegNo", "Roll number", "Roll no") ?? "").trim(),
      name: String(field(r.fields, "Name") ?? "").trim(),
      email: String(field(r.fields, "Email") ?? "").trim().toLowerCase(),
    }))
    .filter((s) => /^\d{11}$/.test(s.regNo) && s.email);
}

async function getStudent(regNo) {
  return (await getRoll()).find((s) => s.regNo === regNo) || null;
}

async function getAdmins() {
  if (!USE_AIRTABLE) return demoAdmins();
  const rows = await cachedTable(TABLES.admins);
  return rows
    .map((r) => ({
      email: String(field(r.fields, "Email") ?? "").trim().toLowerCase(),
      name: String(field(r.fields, "Name") ?? "").trim(),
    }))
    .filter((a) => a.email);
}

async function getAdmin(email) {
  const e = String(email || "").trim().toLowerCase();
  return (await getAdmins()).find((a) => a.email === e) || null;
}


async function getTests() {
  if (!USE_AIRTABLE) return DEMO.tests;

  try {
    console.log("[getTests] Fetching Airtable tests...");
    console.log("[getTests] Table:", TABLES.tests);

    const rows = await cachedTable(TABLES.tests);

    console.log("[getTests] Rows received:", rows.length);

    const anyActive = rows.some(
      (r) => field(r.fields, "Active") === true
    );

    const tests = rows
      .filter((r) => !anyActive || field(r.fields, "Active") === true)
      .map((r) => {
        const minutes = Number(
          field(r.fields, "Duration", "Duration minutes", "Minutes")
        );

        return {
          id: r.id,
          title: String(field(r.fields, "Title", "Name") ?? "Untitled test"),
          durationSeconds: (minutes > 0 ? minutes : 5) * 60,
        };
      });

    console.log("[getTests] Tests returned:", tests.length);
    return tests;
  } catch (err) {
    console.error("[getTests] Airtable error:", err);
    throw err;
  }
}


async function getTest(id) {
  return (await getTests()).find((t) => t.id === id) || null;
}

// Returns [{ id, question, options[], correctIndex }] for one test
async function getQuestions(test) {
  if (!USE_AIRTABLE) return DEMO.questions;
  const rows = await cachedTable(TABLES.mcqs);
  const out = [];
  for (const r of rows) {
    const link = field(r.fields, "Test");
    const belongs = Array.isArray(link)
      ? link.includes(test.id) || link.includes(test.title)
      : link !== undefined && (String(link) === test.id || String(link) === test.title);
    if (!belongs) continue;

    const question = String(field(r.fields, "Question") ?? "").trim();
    const raw = [
      field(r.fields, "Option A", "A"),
      field(r.fields, "Option B", "B"),
      field(r.fields, "Option C", "C"),
      field(r.fields, "Option D", "D"),
    ].map((o) => String(o ?? "").trim());

    // The correct option can be a letter (A-D), a number (1-4) or the option text itself
    const c = String(field(r.fields, "Correct option", "Correct answer", "Answer", "Correct") ?? "").trim();
    let correctText = c;
    if (/^[A-Da-d]$/.test(c)) correctText = raw[c.toUpperCase().charCodeAt(0) - 65];
    else if (/^[1-4]$/.test(c)) correctText = raw[Number(c) - 1];

    const options = raw.filter(Boolean);
    const correctIndex = options.findIndex((o) => o.toLowerCase() === String(correctText || "").toLowerCase());
    if (!question || options.length < 2 || correctIndex === -1) {
      console.warn("Skipping an MCQ with missing or invalid data (Airtable record " + r.id + ")");
      continue;
    }
    out.push({ id: r.id, question, options, correctIndex });
  }
  return out;
}

module.exports = { USE_AIRTABLE, getRoll, getStudent, getAdmins, getAdmin, getTests, getTest, getQuestions };