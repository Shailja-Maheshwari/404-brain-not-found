// Backend ka poora flow check karta hai:  node e2e-test.js
// Pehle backend chalao (npm run dev). Local .env me DEV_SHOW_OTP=true chahiye (sirf local testing ke liye).
// Admin ke liye: ADMIN_EMAIL=<Admins table wali email> node e2e-test.js   (demo mode me admin@example.com)
require("dotenv").config();
const API = process.env.API_URL || "http://localhost:5000";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || process.env.DEMO_ADMIN_EMAIL || "guptapriyanshi522@gmail.com").trim().toLowerCase();

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (extra ? "   -> " + extra : "")); }
}

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: "Bearer " + token }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const stamp = String(Date.now());
const regNo = "1" + stamp.slice(-10);          // 11 digits
const email = "e2e." + stamp + "@example.com";
const name = "E2E Test Student";
const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const descriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.1);

async function run() {
  console.log("Backend: " + API + "\n");

  console.log("1) Server");
  const health = await call("/api/health");
  ok(health.status === 200 && health.json.db === true, "server up, MongoDB connected", JSON.stringify(health.json));
  console.log("  Data source: " + health.json.source + (health.json.source === "airtable" ? "  (MCQs Airtable se aa rahe hain)" : "  (DEMO data, Airtable keys .env me daalo)"));

  console.log("\n2) Student registration (pehli baar login)");
  const send = await call("/api/auth/otp/send", { method: "POST", body: { name, regNo, email } });
  ok(send.status === 200, "OTP send", JSON.stringify(send.json));
  if (!send.json.devOtp) {
    console.log("\n  devOtp nahi mila. Local .env me DEV_SHOW_OTP=true karke server restart karo.");
    return;
  }
  const verify = await call("/api/auth/otp/verify", { method: "POST", body: { name, regNo, email, otp: send.json.devOtp } });
  ok(verify.status === 200 && verify.json.token, "OTP verify, student ban gaya", JSON.stringify(verify.json));
  const loginToken = verify.json.token;
  if (!loginToken) return;

  const clash = await call("/api/auth/otp/send", { method: "POST", body: { name, regNo, email: "other." + email } });
  ok(clash.status === 409, "wahi reg no doosri email se -> 409 (reject)", "status " + clash.status);

  console.log("\n3) Face register + test session");
  const face = await call("/api/face/register", { method: "POST", token: loginToken, body: { descriptor, photo } });
  ok(face.status === 200 && face.json.token, "face register", JSON.stringify(face.json));
  const testToken = face.json.token;
  if (!testToken) return;
  const hb = await call("/api/session/heartbeat", { method: "POST", token: testToken });
  ok(hb.status === 200, "heartbeat");

  console.log("\n4) Tests aur MCQs");
  const tests = await call("/api/tests", { token: testToken });
  const list = tests.json.tests || [];
  ok(tests.status === 200 && list.length > 0, "tests list (" + list.length + " test)", JSON.stringify(tests.json));
  if (!list.length) return;
  const test = list[0];
  console.log("  Test: " + test.title + " (" + test.durationSeconds / 60 + " min)");
  const qs = await call("/api/tests/" + test.id + "/questions", { token: testToken });
  const questions = qs.json.questions || [];
  ok(qs.status === 200 && questions.length > 0, "questions mile (" + questions.length + ")", JSON.stringify(qs.json));
  ok(!JSON.stringify(questions).toLowerCase().includes("correct"), "sahi jawab frontend ko nahi bheje gaye");
  if (!questions.length) return;
  console.log("  Pehla sawal: " + questions[0].question);

  console.log("\n5) Submit (violations + snapshot ke saath)");
  const answers = {};
  questions.forEach((q) => { answers[q.id] = q.options[0]; });
  const events = [
    { type: "HEAD_TURN", severity: "medium", timestamp: Date.now(), questionNo: 1, riskScore: 10, meta: {}, snapshot: photo },
    { type: "TAB_VISIT", severity: "low", timestamp: Date.now(), questionNo: 2, riskScore: 0, meta: { url: "https://chatgpt.com", title: "ChatGPT", query: "what is binary search" } },
  ];
  const sub = await call("/api/test/submit", { method: "POST", token: testToken, body: { testId: test.id, answers, events, reason: "E2E test submit" } });
  ok(sub.status === 200 && sub.json.ok, "submit, score " + sub.json.score + "/" + sub.json.total, JSON.stringify(sub.json));
  const again = await call("/api/test/submit", { method: "POST", token: testToken, body: { testId: test.id, answers, events: [] } });
  ok(again.status === 401 || again.status === 409, "dobara submit nahi hota", "status " + again.status);

  console.log("\n6) Admin ko data dikhta hai?");
  const asend = await call("/api/admin/otp/send", { method: "POST", body: { email: ADMIN_EMAIL } });
  ok(asend.status === 200, "admin OTP send", JSON.stringify(asend.json));
  if (!asend.json.devOtp) {
    console.log("\n  Admin devOtp nahi mila: ADMIN_EMAIL Admins me nahi hai (ya DEV_SHOW_OTP off). ADMIN_EMAIL=... karke chalao.");
    return;
  }
  const averify = await call("/api/admin/otp/verify", { method: "POST", body: { email: ADMIN_EMAIL, otp: asend.json.devOtp } });
  ok(averify.status === 200 && averify.json.token, "admin login", JSON.stringify(averify.json));
  const at = averify.json.token;
  if (!at) return;

  const sl = await call("/api/admin/students", { token: at });
  const me = (sl.json.students || []).find((s) => s.regNo === regNo);
  ok(!!me, "admin students list me ye student hai");
  if (me) {
    ok(me.name === name && me.email === email, "naam aur email sahi");
    ok(me.faceRegistered === true && !!me.facePhotoUrl, "registered face photo dikh rahi hai");
    ok(me.attemptsCount === 1 && me.latest && typeof me.latest.score === "number", "latest attempt aur marks dikh rahe hain");
  }
  const detail = await call("/api/admin/students/" + regNo, { token: at });
  const att = (detail.json.attempts || [])[0];
  ok(!!att && att.events.length === 2, "student detail me 2 violation events", JSON.stringify(att && att.events.map((e) => e.type)));
  ok(!!att && att.events.some((e) => e.snapshotUrl), "violation ka snapshot admin ko mil raha hai");
  ok(!!att && att.events.some((e) => e.type === "TAB_VISIT" && e.meta && e.meta.url), "tab visit (url + search) save hua");
  const rec = await call("/api/admin/records", { token: at });
  ok((rec.json.records || []).some((r) => r.regNo === regNo), "records tab me entry hai");

  console.log("\n7) Safai (test student hata rahe hain)");
  await call("/api/admin/students/" + regNo + "/results", { method: "DELETE", token: at });
  const del = await call("/api/admin/students/" + regNo, { method: "DELETE", token: at });
  console.log("  " + (del.status === 200 ? "test student delete ho gaya" : "student delete nahi hua (status " + del.status + "), Atlas me e2e.* wale record haath se hata do"));
}

run()
  .catch((e) => { failed++; console.log("\n  ERROR  " + e.message + "  (backend chal raha hai? API_URL sahi hai?)"); })
  .finally(() => {
    console.log("\n" + passed + " pass, " + failed + " fail");
    process.exit(failed ? 1 : 0);
  });