// Airtable connection ka check:  node airtable-check.js   (proctor-backend folder me, .env wahi hai)
// Keys print nahi hoti, sirf shuru ke 3 letters aur length.
require("dotenv").config();

const KEY = (process.env.AIRTABLE_API_KEY || "").toString();
const BASE = (process.env.AIRTABLE_BASE_ID || "").toString();
const TABLES = [
  ["Admins", process.env.AIRTABLE_TABLE_ADMINS || "Admins"],
  ["Tests", process.env.AIRTABLE_TABLE_TESTS || "Tests"],
  ["MCQs", process.env.AIRTABLE_TABLE_MCQS || "MCQs"],
];

const hint = (status, type) => {
  if (status === 401) return "Token galat/expire hai. .env me AIRTABLE_API_KEY (pat... wala) dobara copy karo, bina quotes aur space ke.";
  if (status === 403) return "Token ko is base ka access nahi ya scope kam hai. Airtable token page: scope data.records:read + Access me ProctorDB base add karo.";
  if (status === 404) return "Table ka naam ya Base ID galat. Table naam bilkul match karo (case bhi), Base ID app... se shuru hona chahiye.";
  if (status === 422) return "Request galat: " + type;
  return "Airtable ne " + status + " diya.";
};

(async () => {
  console.log("API key : " + (KEY ? KEY.slice(0, 3) + "...  (" + KEY.length + " characters)" : "MISSING"));
  console.log("Base ID : " + (BASE ? BASE.slice(0, 3) + "...  (" + BASE.length + " characters)" : "MISSING"));
  if (!KEY || !BASE) return console.log("\n.env me AIRTABLE_API_KEY aur AIRTABLE_BASE_ID dono chahiye.");
  if (/["'\s]/.test(KEY) || /["'\s]/.test(BASE)) console.log("  WARNING: key ya base id me quote/space hai, .env me hatao.");
  if (!KEY.startsWith("pat")) console.log("  WARNING: API key 'pat' se shuru nahi hoti (Personal Access Token chahiye).");
  if (!BASE.startsWith("app")) console.log("  WARNING: Base ID 'app' se shuru nahi hota (tbl.../viw... mat daalo).");

  for (const [label, table] of TABLES) {
    console.log("\n" + label + '  (table naam: "' + table + '")');
    try {
      const res = await fetch("https://api.airtable.com/v0/" + BASE + "/" + encodeURIComponent(table) + "?pageSize=5", {
        headers: { Authorization: "Bearer " + KEY },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = json.error || {};
        const type = typeof err === "string" ? err : err.type || "";
        console.log("  FAIL  status " + res.status + (type ? "  (" + type + ")" : "") + (err.message ? "  - " + err.message : ""));
        console.log("  Kya karna hai: " + hint(res.status, type));
        continue;
      }
      const rows = json.records || [];
      console.log("  OK    " + rows.length + " record(s) pehle page me");
      const fields = new Set();
      rows.forEach((r) => Object.keys(r.fields).forEach((f) => fields.add(f)));
      console.log("  Fields mile: " + (fields.size ? [...fields].join(", ") : "(table khali hai)"));
      if (!rows.length) console.log("  NOTE: table khali hai, isme data daalo.");
      if (label === "Tests" && fields.size && ![...fields].some((f) => /^(title|name)$/i.test(f))) console.log("  NOTE: 'Title' field nahi mila.");
      if (label === "MCQs" && rows.length) {
        const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const fieldNames = [...fields].map((f) => norm(f));
        const checkPresent = (candidates) => candidates.some((c) => fieldNames.includes(norm(c)));
        if (!checkPresent(["Question", "Questions", "QuestionText"])) console.log("  NOTE: 'Question' / 'Questions' field nahi mila.");
        ["Option A", "Option B", "Option C", "Option D"].forEach((opt) => {
          if (!checkPresent([opt])) console.log("  NOTE: '" + opt + "' field nahi mila.");
        });
        if (!checkPresent(["Test", "Tests"])) console.log("  NOTE: 'Test' / 'Tests' field nahi mila.");
        if (!checkPresent(["Correct Answer", "Correct Option", "Answer", "Correct"])) console.log("  NOTE: 'Correct Answer' field nahi mila.");
      }
    } catch (e) {
      console.log("  FAIL  Airtable tak pahunch nahi paye: " + e.message + "  (internet / VPN / firewall check karo)");
    }
  }
  console.log("\nSab OK ho to backend restart karke e2e-test.js dobara chalao.");
})();