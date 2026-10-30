require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const { Student, Otp, Lock, Attempt, Violation, Verification, ActivityLog } = require("./models");
const data = require("./dataSource");

// ---------- CONFIG ----------
const PORT = Number(process.env.PORT) || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD) || 0.45;
const DEV_SHOW_OTP = process.env.DEV_SHOW_OTP === "true";
const MAX_FAILS = 10;                                   // wrong tries before a lock
const LOCK_MINUTES = Number(process.env.LOCK_MINUTES) || 5;
const MAX_STRIKES = Number(process.env.MAX_STRIKES) || 3;
const OTP_MINUTES = 5;                                  // how long an OTP stays valid
const OTP_RESEND_MS = 30 * 1000;                        // minimum gap between two OTP requests
const OTP_MAX_TRIES = 5;                                // wrong tries on one OTP before it is cancelled
const SESSION_IDLE_MS = 2 * 60 * 1000;                  // no heartbeat for this long = the session is dead
const STUDENT_TOKEN_TTL = "12h";                        // student login
const TEST_TOKEN_TTL = "4h";                            // one test session (after the face check)
const ADMIN_TOKEN_TTL = "8h";                           // admin login
const MAX_EVENTS = 200;                                 // violations stored per attempt
const MAX_SNAPSHOTS = 40;                               // snapshots stored per attempt
const MAX_IMAGE_BYTES = 300 * 1024;                     // size limit of one image

if (JWT_SECRET.length < 16) {
  console.error("JWT_SECRET in .env is missing or too short (use at least 32 random characters).");
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error("MONGODB_URI in .env is missing. Paste your MongoDB Atlas connection string.");
  process.exit(1);
}

// ---------- HELPERS ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sign = (payload, expiresIn) => jwt.sign(payload, JWT_SECRET, { expiresIn });
const bearer = (req) => {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};
const cleanReg = (v) => String(v || "").trim();
const validReg = (v) => /^\d{4,15}$/.test(v);
const cleanEmail = (v) => String(v || "").trim().toLowerCase();
const hasFace = (s) => !!(s && s.face && s.face.descriptor && s.face.descriptor.length === 128);
const publicStudent = (s) => ({ regNo: s.regNo, name: s.name, email: s.email });
const secondsLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 1000));

const cleanName = (v) => String(v || "").trim().replace(/\s+/g, " ");
const validName = (v) => v.length >= 2 && v.length <= 80;
const validEmail = (v) => /^\S+@\S+\.\S+$/.test(v) && v.length <= 120;

// Optional: sirf college emails allow karne ke liye .env me ALLOWED_EMAIL_DOMAIN=yourcollege.edu
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "").trim().toLowerCase();
const emailAllowed = (e) => !ALLOWED_DOMAIN || e.endsWith("@" + ALLOWED_DOMAIN);

// OTP aur lock ki key reg no + email dono se bani hai, taki OTP usi email ka ho jis par gaya
const studentKey = (regNo, email) => "student:" + regNo + ":" + email;

// Rule: ek reg no, ek email. Rule tootta ho to message milta hai, warna null.
async function identityConflict(regNo, email) {
  const [byReg, byEmail] = await Promise.all([
    Student.findOne({ regNo }, "email"),
    Student.findOne({ email }, "regNo"),
  ]);
  if (byReg && byReg.email && byReg.email !== email)
    return "This registration number is already registered with a different email.";
  if (byEmail && byEmail.regNo !== regNo)
    return "This email is already registered with a different registration number.";
  return null;
}

function readStudentForm(body, requireName = false) {
  const name = cleanName(body.name);
  const regNo = cleanReg(body.regNo || body.registrationNumber);
  const email = cleanEmail(body.email);
  let error = null;
  if (requireName && !validName(name)) error = "Please enter your full name.";
  else if (body.name && !validName(name)) error = "Please enter your full name.";
  else if (!validReg(regNo)) error = "Registration number must be between 4 and 15 digits.";
  else if (!validEmail(email)) error = "Please enter a valid email address.";
  else if (!emailAllowed(email)) error = "Please use your college email (@" + ALLOWED_DOMAIN + ").";
  return { name, regNo, email, error };
}

function hashOtp(code) {
  return crypto.createHmac("sha256", JWT_SECRET).update(code).digest("hex");
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ----- Face descriptors (128 numbers per face) -----
function validDescriptor(d) {
  return Array.isArray(d) && d.length === 128 && d.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 5);
}
function faceDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// ----- Images (face photo and violation snapshots, sent as JPEG/PNG data URLs) -----
function cleanImage(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes < 20 || bytes > MAX_IMAGE_BYTES) return null;
  return dataUrl;
}
function safeMeta(m) {
  try {
    const t = JSON.stringify(m || {});
    return t.length <= 500 ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

// ----- Lock after too many wrong attempts (10 wrong = 5 minute lock) -----
async function lockedUntil(key) {
  const l = await Lock.findOne({ key });
  return l && l.until && l.until > new Date() ? l.until.getTime() : 0;
}
async function recordFail(key) {
  const l = await Lock.findOneAndUpdate({ key }, { $inc: { fails: 1 } }, { upsert: true, new: true });
  if (l.fails >= MAX_FAILS) {
    const until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
    await Lock.updateOne({ key }, { $set: { fails: 0, until } });
    return { locked: true, until: until.getTime(), left: 0 };
  }
  return { locked: false, until: 0, left: MAX_FAILS - l.fails };
}
const clearFails = (key) => Lock.deleteOne({ key });
const lockedBody = (until) => ({
  error: "Too many wrong attempts. This account is locked.",
  code: "LOCKED",
  retryAfterSeconds: secondsLeft(until),
});

// ----- OTP (email) -----
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendOtpMail(email, code) {
  const subject = `Your Smart Proctor Verification Code: ${code}`;
  const text = `Your Smart Proctor verification OTP is ${code}. It is valid for ${OTP_MINUTES} minutes. Never share this code with anyone.`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
      <div style="margin-bottom: 24px;">
        <span style="background: #2563eb; color: #ffffff; font-weight: bold; font-size: 16px; padding: 6px 12px; border-radius: 8px; display: inline-block;">SP</span>
        <h2 style="display: inline-block; margin: 0 0 0 10px; color: #0f172a; font-size: 20px; vertical-align: middle;">Smart Proctor Portal</h2>
      </div>
      <p style="color: #334155; font-size: 15px; margin: 0 0 16px;">Hello,</p>
      <p style="color: #334155; font-size: 15px; line-height: 1.5; margin: 0 0 24px;">
        Use the following one-time password (OTP) to securely sign in to your examination portal:
      </p>
      <div style="background: #eff6ff; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; text-align: center; margin: 0 0 24px;">
        <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #1d4ed8; font-family: 'Courier New', monospace;">${code}</span>
      </div>
      <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0 0 8px;">
        ⏳ This code is valid for <b>${OTP_MINUTES} minutes</b>. Do not share this OTP with anyone.
      </p>
      <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0 16px;" />
      <p style="color: #94a3b8; font-size: 12px; margin: 0;">Smart Proctoring System · WUElev8 Hackathon</p>
    </div>
  `;

  if (process.env.BREVO_API_KEY) {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "Smart Proctor Portal", email: process.env.MAIL_FROM || "guptapriyanshi522@gmail.com" },
        to: [{ email }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error("Brevo API error:", r.status, errBody);
      throw new Error("Brevo returned " + r.status);
    }
    return;
  }
  if (!transporter) {
    console.log("[OTP] " + email + " -> " + code + "  (no email service configured)");
    return;
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject,
    text,
    html,
  });
}

// Creates an OTP for a key, stores only its hash and emails it
async function issueOtp(key, email, res) {
  const existing = await Otp.findOne({ key });
  if (existing && Date.now() - existing.sentAt.getTime() < OTP_RESEND_MS) {
    return res.status(429).json({ error: "Please wait a few seconds before requesting another OTP." });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await Otp.findOneAndUpdate(
    { key },
    { hash: hashOtp(code), attempts: 0, sentAt: new Date(), expiresAt: new Date(Date.now() + OTP_MINUTES * 60 * 1000) },
    { upsert: true }
  );
  let emailSent = false;
  try {
    await sendOtpMail(email, code);
    emailSent = true;
  } catch (e) {
    console.error("OTP email delivery error:", e.message);
    if (!DEV_SHOW_OTP) {
      return res.status(502).json({ error: "Could not send the OTP email. Please ensure your email address is correct." });
    }
  }
  res.json({
    ok: true,
    message: "OTP sent to your email.",
    expiresInSeconds: OTP_MINUTES * 60,
  });
}

// Checks an OTP. Wrong tries are counted, and 10 wrong tries lock the account for 5 minutes.
async function checkOtp(key, otp) {
  const rec = await Otp.findOne({ key });
  if (!rec || rec.expiresAt < new Date()) {
    return { ok: false, status: 400, body: { error: "The OTP has expired. Please request a new one.", code: "OTP_EXPIRED" } };
  }
  const good = /^\d{6}$/.test(otp) && safeEqual(hashOtp(otp), rec.hash);
  if (!good) {
    rec.attempts += 1;
    if (rec.attempts >= OTP_MAX_TRIES) await Otp.deleteOne({ key });
    else await rec.save();
    const f = await recordFail(key);
    if (f.locked) return { ok: false, status: 429, body: lockedBody(f.until) };
    return { ok: false, status: 401, body: { error: "Incorrect OTP.", attemptsLeft: f.left } };
  }
  await Otp.deleteOne({ key });
  await clearFails(key);
  return { ok: true };
}

// One active session per student: a second login from another device is refused
async function startSession(regNo) {
  const sid = crypto.randomUUID();
  const cutoff = new Date(Date.now() - SESSION_IDLE_MS);
  const r = await Student.updateOne(
    { regNo, $or: [{ session: { $exists: false } }, { "session.lastSeen": { $lt: cutoff } }] },
    { $set: { session: { id: sid, lastSeen: new Date() } } }
  );
  return r.modifiedCount === 1 ? sid : null;
}

// ---------- AUTH MIDDLEWARE ----------
// Token purposes: "login" (after the OTP), "test" (after the face check), "admin" (after the admin OTP)
function requireStudent(...purposes) {
  return wrap(async (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "Login required" });
    let p;
    try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid or expired token" }); }
    if (!purposes.includes(p.purpose)) return res.status(403).json({ error: "This token cannot be used here" });
    const s = await Student.findOne({ regNo: p.regNo });
    if (!s) return res.status(401).json({ error: "Student not found" });
    if (p.purpose === "test" && (!s.session || s.session.id !== p.sid)) {
      return res.status(401).json({ error: "Session ended. Please log in again.", code: "SESSION_ENDED" });
    }
    req.student = s;
    req.token = p;
    next();
  });
}

const requireAdmin = wrap(async (req, res, next) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "Admin login required" });
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid or expired token" }); }
  if (p.purpose !== "admin") return res.status(403).json({ error: "Admins only" });
  const admin = await data.getAdmin(p.email);
  if (!admin) return res.status(401).json({ error: "Admin not found" });
  req.admin = admin;
  next();
});

// ---------- APP SETUP ----------
const app = express();
if (process.env.TRUST_PROXY || process.env.RENDER) app.set("trust proxy", 1); // needed behind Render's proxy

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175")
  .split(",").map((s) => s.trim()).filter(Boolean);

const corsMiddleware = cors({
  origin: (origin, cb) => {
    // null for electron local file, undefined for server-to-server / curl
    if (!origin || origin === "null") return cb(null, true);
    if (LOCAL_ORIGIN_REGEX.test(origin) || ORIGINS.includes(origin)) return cb(null, true);
    // Dev-friendly fallback: allow origin
    return cb(null, true);
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
});

app.use(corsMiddleware);
app.options("*", corsMiddleware);
app.use(express.json({ limit: "10mb" })); // room for violation snapshots

const generalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many OTP requests. Please wait a few minutes." },
});
const adminOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many admin login attempts. Try again in 15 minutes." },
});
app.use("/api", generalLimiter);

app.get("/api/health", (req, res) =>
  res.json({ ok: true, time: Date.now(), source: data.USE_AIRTABLE ? "airtable" : "demo", db: mongoose.connection.readyState === 1 })
);

// ---------- STUDENT: LOGIN (registration number + email + OTP) ----------
const handleSendOtp = wrap(async (req, res) => {
  const { regNo, email, error } = readStudentForm(req.body, false);
  if (error) return res.status(400).json({ error });

  const conflict = await identityConflict(regNo, email);
  if (conflict) return res.status(409).json({ error: conflict, code: "IDENTITY_CONFLICT" });

  const key = studentKey(regNo, email);
  const until = await lockedUntil(key);
  if (until) return res.status(429).json(lockedBody(until));
  return issueOtp(key, email, res);
});

const handleVerifyOtp = wrap(async (req, res) => {
  let { name, regNo, email, error } = readStudentForm(req.body, false);
  if (error) return res.status(400).json({ error });
  const otp = String(req.body.otp || "").trim();

  const conflict = await identityConflict(regNo, email);
  if (conflict) return res.status(409).json({ error: conflict, code: "IDENTITY_CONFLICT" });

  const key = studentKey(regNo, email);
  const until = await lockedUntil(key);
  if (until) return res.status(429).json(lockedBody(until));

  const r = await checkOtp(key, otp);
  if (!r.ok) return res.status(r.status).json(r.body);

  const existing = await Student.findOne({ regNo });
  if (!name && existing && existing.name) name = existing.name;
  if (!name) name = "Student " + regNo.slice(-4);

  let student;
  try {
    student = await Student.findOneAndUpdate(
      { regNo },
      { $set: { email }, $setOnInsert: { name } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (e) {
    if (e.code === 11000)
      return res.status(409).json({ error: "This registration number or email is already registered.", code: "IDENTITY_CONFLICT" });
    throw e;
  }
  res.json({
    token: sign({ purpose: "login", regNo }, STUDENT_TOKEN_TTL),
    student: publicStudent(student),
    faceRegistered: hasFace(student),
  });
});

app.post("/api/auth/otp/send", otpLimiter, handleSendOtp);
app.post("/api/auth/send-otp", otpLimiter, handleSendOtp);

app.post("/api/auth/otp/verify", handleVerifyOtp);
app.post("/api/auth/verify-otp", handleVerifyOtp);

//Tests available to the student (the dashboard)
app.get("/api/tests", requireStudent("login", "test"), wrap(async (req, res) => {
  try {
    const tests = await data.getTests();

    console.log("GET /api/tests: fetched", tests?.length, "tests");

    res.json({
      maxStrikes: MAX_STRIKES,
      tests: tests.map((t) => ({
        id: t.id,
        title: t.title,
        durationSeconds: t.durationSeconds
      }))
    });
  } catch (err) {
    console.error("TESTS LIST ERROR:", err);
    throw err;
  }
}));


// Past results of this student
app.get("/api/results/me", requireStudent("login", "test"), wrap(async (req, res) => {
  const list = await Attempt.find({ regNo: req.student.regNo }).sort({ submittedAt: -1 }).limit(50).lean();
  res.json({
    results: list.map((a) => ({
      id: String(a._id),
      testTitle: a.testTitle,
      submittedAt: a.submittedAt,
      score: a.score,
      total: a.total,
      answered: a.answered,
      strikes: a.strikes,
      violations: a.eventCount,
      reason: a.reason,
    })),
  });
}));

// ---------- STUDENT: FACE (registered once, then verified) ----------
// Registers the face. Allowed only once per student. It also starts the test session.
app.post("/api/face/register", requireStudent("login"), wrap(async (req, res) => {
  const s = req.student;
  if (hasFace(s)) return res.status(409).json({ error: "Face already registered.", code: "FACE_EXISTS" });
  if (!validDescriptor(req.body.descriptor)) return res.status(400).json({ error: "Invalid face data." });
  const photo = cleanImage(req.body.photo);
  if (!photo) return res.status(400).json({ error: "A valid face photo (JPEG or PNG, under 300 KB) is required." });

  const sid = await startSession(s.regNo);
  if (!sid) return res.status(409).json({ error: "This account is already logged in on another device.", code: "ALREADY_LOGGED_IN" });

  // The filter makes sure the face can be saved only once, even if two requests arrive together
  const r = await Student.updateOne(
    { regNo: s.regNo, face: { $exists: false } },
    { $set: { face: { descriptor: req.body.descriptor, photo, registeredAt: new Date() } } }
  );
  if (r.modifiedCount !== 1) {
    await Student.updateOne({ regNo: s.regNo }, { $unset: { session: 1 } });
    return res.status(409).json({ error: "Face already registered.", code: "FACE_EXISTS" });
  }
  res.json({
    ok: true,
    token: sign({ purpose: "login", regNo: s.regNo, sid }, STUDENT_TOKEN_TTL),
    student: publicStudent(s),
    faceRegistered: true,
    faceDescriptor: req.body.descriptor,
    maxStrikes: MAX_STRIKES,
  });
}));

// The live face is compared with the stored face here, on the server
app.post("/api/auth/face-verify", requireStudent("login"), wrap(async (req, res) => {
  const s = req.student;
  if (!hasFace(s)) return res.status(409).json({ error: "Your face is not registered yet.", code: "FACE_NOT_REGISTERED" });
  const key = "face:" + s.regNo;
  const until = await lockedUntil(key);
  if (until) return res.status(429).json(lockedBody(until));
  if (!validDescriptor(req.body.descriptor)) return res.status(400).json({ error: "Invalid face data." });

  const distance = faceDistance(req.body.descriptor, Array.from(s.face.descriptor));
  if (distance >= FACE_THRESHOLD) {
    const f = await recordFail(key);
    if (f.locked) return res.status(429).json(lockedBody(f.until));
    return res.status(401).json({ match: false, error: "Face did not match the registered face.", attemptsLeft: f.left });
  }
  await clearFails(key);

  res.json({
    match: true,
    token: sign({ purpose: "login", regNo: s.regNo }, STUDENT_TOKEN_TTL),
    student: publicStudent(s),
    faceRegistered: true,
    faceDescriptor: Array.from(s.face.descriptor),
  });
}));

// Provide registered face reference descriptor for live comparison in exam
app.get("/api/face/reference", requireStudent("test", "login"), wrap(async (req, res) => {
  const s = req.student;
  if (!hasFace(s)) return res.status(404).json({ error: "No registered face found." });
  res.json({ descriptor: Array.from(s.face.descriptor) });
}));

// ---------- STUDENT: TEST IDENTITY RE-VERIFICATION BEFORE EVERY TEST ----------
// Live face capture & descriptor compared with registered face in MongoDB before every test
app.post("/api/tests/:testId/verify-identity", requireStudent("login", "test"), wrap(async (req, res) => {
  const s = req.student;
  const testId = req.params.testId;
  const testTitle = req.body.testTitle || "Online Exam";

  if (!hasFace(s)) {
    return res.status(409).json({
      error: "Your face is not registered yet. Please complete face registration first.",
      code: "FACE_NOT_REGISTERED",
    });
  }

  const key = "face:" + s.regNo + ":" + testId;
  const until = await lockedUntil(key);
  if (until) return res.status(429).json(lockedBody(until));

  if (!validDescriptor(req.body.descriptor)) {
    return res.status(400).json({ error: "Invalid face descriptor data." });
  }

  const photo = cleanImage(req.body.photo) || (s.face && s.face.photo) || "";

  const distance = faceDistance(req.body.descriptor, Array.from(s.face.descriptor));
  const isMatch = distance < FACE_THRESHOLD;

  // Count recent failed attempts for this test in the last 15 minutes
  const recentFails = await Verification.countDocuments({
    regNo: s.regNo,
    testId,
    status: "failed",
    verifiedAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) },
  });

  const verification = await Verification.create({
    regNo: s.regNo,
    studentId: s._id,
    studentName: s.name,
    studentEmail: s.email,
    testId,
    testTitle,
    status: isMatch ? "passed" : "failed",
    verifiedAt: new Date(),
    distance: Number(distance.toFixed(4)),
    threshold: FACE_THRESHOLD,
    photo,
    failureReason: isMatch
      ? null
      : `Face similarity distance (${distance.toFixed(3)}) exceeded threshold (${FACE_THRESHOLD})`,
  });

  if (!isMatch) {
    const f = await recordFail(key);
    const retriesLeft = Math.max(0, 3 - recentFails - 1);
    return res.status(401).json({
      match: false,
      error: "Identity verification failed. Your face did not match the registered profile.",
      distance: Number(distance.toFixed(4)),
      threshold: FACE_THRESHOLD,
      retriesLeft,
      canRequestReview: true,
      verificationId: String(verification._id),
    });
  }

  await clearFails(key);

  let sid = req.token && req.token.sid;
  if (!sid) {
    sid = await startSession(s.regNo);
    if (!sid) {
      sid = crypto.randomUUID();
      await Student.updateOne({ regNo: s.regNo }, { $set: { session: { id: sid, lastSeen: new Date() } } });
    }
  }

  const testToken = sign(
    {
      purpose: "test",
      regNo: s.regNo,
      sid,
      testId,
      verificationId: String(verification._id),
    },
    TEST_TOKEN_TTL
  );

  res.json({
    match: true,
    token: testToken,
    verification: {
      id: String(verification._id),
      status: "passed",
      distance: Number(distance.toFixed(4)),
    },
    faceDescriptor: Array.from(s.face.descriptor),
    student: publicStudent(s),
    maxStrikes: MAX_STRIKES,
  });
}));

// Fallback: Student requests admin review if face verification fails legitimately
app.post("/api/tests/:testId/request-review", requireStudent("login", "test"), wrap(async (req, res) => {
  const { verificationId, reason } = req.body;
  if (!verificationId) return res.status(400).json({ error: "verificationId is required" });

  const ver = await Verification.findOne({ _id: verificationId, regNo: req.student.regNo });
  if (!ver) return res.status(404).json({ error: "Verification record not found" });

  ver.status = "pending_review";
  ver.failureReason = reason || "Student requested manual admin review";
  await ver.save();

  res.json({ ok: true, message: "Review request submitted to exam supervisor.", status: "pending_review" });
}));

// Poll verification status (when student is awaiting supervisor approval)
app.get("/api/tests/:testId/verification-status/:verificationId", requireStudent("login", "test"), wrap(async (req, res) => {
  const ver = await Verification.findOne({ _id: req.params.verificationId, regNo: req.student.regNo });
  if (!ver) return res.status(404).json({ error: "Verification record not found" });

  if (ver.status === "admin_approved" || ver.status === "passed") {
    let sid = req.token && req.token.sid;
    if (!sid) {
      sid = await startSession(req.student.regNo);
    }
    const testToken = sign(
      {
        purpose: "test",
        regNo: req.student.regNo,
        sid: sid || crypto.randomUUID(),
        testId: req.params.testId,
        verificationId: String(ver._id),
      },
      TEST_TOKEN_TTL
    );
    const faceDescriptor = req.student.face && req.student.face.descriptor ? Array.from(req.student.face.descriptor) : null;
    return res.json({ status: ver.status, match: true, token: testToken, faceDescriptor });
  }

  res.json({ status: ver.status, match: false });
}));

// Examination activity tracking (Electron & browser window events)
app.post("/api/test/activity", requireStudent("test"), wrap(async (req, res) => {
  const { testId, testTitle, eventType, tabTitle, tabUrl, duration, metadata } = req.body;
  if (!eventType) return res.status(400).json({ error: "eventType is required" });

  await ActivityLog.create({
    regNo: req.student.regNo,
    studentId: req.student._id,
    testId: testId || req.token.testId || "",
    testTitle: testTitle || "",
    sessionId: req.token.sid || "",
    eventType: String(eventType).toUpperCase(),
    timestamp: new Date(),
    tabTitle: String(tabTitle || ""),
    tabUrl: String(tabUrl || ""),
    duration: Number(duration) || 0,
    metadata: metadata || {},
  });

  res.json({ ok: true });
}));

// ---------- STUDENT: DURING THE TEST ----------
// Keeps the session alive (the app calls this every ~30 seconds)
app.post("/api/session/heartbeat", requireStudent("test"), wrap(async (req, res) => {
  await Student.updateOne({ regNo: req.student.regNo }, { $set: { "session.lastSeen": new Date() } });
  res.json({ ok: true });
}));

app.post("/api/session/logout", requireStudent("test"), wrap(async (req, res) => {
  await Student.updateOne({ regNo: req.student.regNo }, { $unset: { session: 1 } });
  res.json({ ok: true });
}));

// Identity re-check while the test is running
app.post("/api/identity/check", requireStudent("test"), (req, res) => {
  const s = req.student;
  if (!hasFace(s)) return res.status(409).json({ error: "Face not registered.", code: "FACE_NOT_REGISTERED" });
  if (!validDescriptor(req.body.descriptor)) return res.status(400).json({ error: "Invalid face data." });
  const distance = faceDistance(req.body.descriptor, Array.from(s.face.descriptor));
  res.json({ match: distance < FACE_THRESHOLD });
});

// Questions are sent WITHOUT the correct answers
// STRICT SECURITY: Verifies that identity check was completed for this test
app.get("/api/tests/:id/questions", requireStudent("test"), wrap(async (req, res) => {
  if (req.token.testId && req.token.testId !== req.params.id) {
    return res.status(403).json({ error: "This authorization token is not valid for this test.", code: "TEST_MISMATCH" });
  }

  if (req.token.verificationId) {
    const ver = await Verification.findOne({
      _id: req.token.verificationId,
      regNo: req.student.regNo,
      testId: req.params.id,
      status: { $in: ["passed", "admin_approved"] },
    });
    if (!ver) {
      return res.status(403).json({
        error: "Identity re-verification is required before starting this test.",
        code: "VERIFICATION_REQUIRED",
      });
    }
  }

  const test = await data.getTest(req.params.id);
  if (!test) return res.status(404).json({ error: "Test not found" });
  const questions = await data.getQuestions(test);
  if (questions.length === 0) return res.status(404).json({ error: "This test has no questions yet." });
  res.json({
    test: { id: test.id, title: test.title, durationSeconds: test.durationSeconds },
    maxStrikes: MAX_STRIKES,
    questions: questions.map((q) => ({ id: q.id, question: q.question, options: q.options })),
  });
}));

app.get("/api/questions", wrap(async (req, res) => {
  const tests = await data.getTests();
  if (!tests.length) return res.status(404).json({ error: "No active tests found." });
  const testId = req.query.testId || (tests[0] && tests[0].id);
  const test = await data.getTest(testId);
  if (!test) return res.status(404).json({ error: "Test not found" });
  const questions = await data.getQuestions(test);
  res.json({
    test: { id: test.id, title: test.title, durationSeconds: test.durationSeconds },
    maxStrikes: MAX_STRIKES,
    questions: questions.map((q) => ({ id: q.id, question: q.question, options: q.options })),
  });
}));

const SEVERITIES = ["low", "medium", "high"];

// Marks are calculated here, on the server
app.post("/api/test/submit", requireStudent("test"), wrap(async (req, res) => {
  const s = req.student;
  const sid = req.token.sid;
  if (await Attempt.exists({ sessionId: sid })) return res.status(409).json({ error: "This test was already submitted." });

  const tests = await data.getTests();
  const testId = String(req.body.testId || (tests[0] && tests[0].id) || "");
  const test = await data.getTest(testId);
  if (!test) return res.status(404).json({ error: "Test not found" });
  const questions = await data.getQuestions(test);

  const answers = (req.body.answers && typeof req.body.answers === "object" ? req.body.answers : req.body.answersMap) || {};
  let score = 0;
  let answered = 0;
  for (const q of questions) {
    const given = answers[String(q.id)] ?? answers[q.id];
    if (given !== undefined && given !== null && String(given).length > 0) {
      answered += 1;
      const isMatch = String(given).toLowerCase() === String(q.options[q.correctIndex]).toLowerCase()
        || (Number(given) === q.correctIndex);
      if (isMatch) score += 1;
    }
  }

  let snaps = 0;
  const events = (Array.isArray(req.body.events) ? req.body.events.slice(0, MAX_EVENTS) : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      let snapshot = null;
      if (snaps < MAX_SNAPSHOTS) {
        snapshot = cleanImage(e.snapshot);
        if (snapshot) snaps += 1;
      }
      return {
        kind: String(e.type || "UNKNOWN").slice(0, 40),
        severity: SEVERITIES.includes(e.severity) ? e.severity : "low",
        timestamp: Number(e.timestamp) || Date.now(),
        questionNo: Number.isFinite(Number(e.questionNo)) ? Number(e.questionNo) : null,
        riskScore: Number(e.riskScore) || 0,
        meta: safeMeta(e.meta),
        snapshot,
      };
    });

  let attempt;
  try {
    attempt = await Attempt.create({
      regNo: s.regNo,
      testId: test.id,
      testTitle: test.title,
      sessionId: sid,
      submittedAt: new Date(),
      score,
      total: questions.length,
      answered,
      reason: String(req.body.reason || "Submitted").slice(0, 120),
      strikes: events.filter((e) => e.severity !== "low").length,
      risk: events.reduce((m, e) => Math.max(m, e.riskScore), 0),
      eventCount: events.length,
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "This test was already submitted." });
    throw e;
  }
  if (events.length) {
    await Violation.insertMany(events.map((e) => ({ ...e, attemptId: attempt._id, regNo: s.regNo })));
  }
  await Student.updateOne({ regNo: s.regNo }, { $unset: { session: 1 } }); // the session ends with the submission
  res.json({ ok: true, score, total: attempt.total, answered });
}));

// ---------- ADMIN: LOGIN (email + OTP, any number of admins) ----------
app.post("/api/admin/otp/send", adminOtpLimiter, wrap(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const admin = /\S+@\S+\.\S+/.test(email) ? await data.getAdmin(email) : null;
  if (!admin) {
    // The same answer for every email, so nobody can find out which emails are admins
    console.log("[ADMIN] OTP requested for an email that is not an admin: " + email);
    return res.json({ ok: true, expiresInSeconds: OTP_MINUTES * 60 });
  }
  const key = "admin:" + admin.email;
  const until = await lockedUntil(key);
  if (until) return res.status(429).json(lockedBody(until));
  return issueOtp(key, admin.email, res);
}));

app.post("/api/admin/otp/verify", adminOtpLimiter, wrap(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const otp = String(req.body.otp || "").trim();
  const admin = /\S+@\S+\.\S+/.test(email) ? await data.getAdmin(email) : null;
  if (!admin) return res.status(401).json({ error: "Incorrect OTP." });
  const key = "admin:" + admin.email;
  const until = await lockedUntil(key);
  if (until) return res.status(429).json(lockedBody(until));

  const r = await checkOtp(key, otp);
  if (!r.ok) return res.status(r.status).json(r.body);
  res.json({ token: sign({ purpose: "admin", email: admin.email }, ADMIN_TOKEN_TTL), admin: { email: admin.email, name: admin.name } });
}));

app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ admin: req.admin }));

// ---------- ADMIN: STUDENTS AND TEST RECORDS ----------
// Students tab: the whole roll with face status and the latest attempt
app.get("/api/admin/students", requireAdmin, wrap(async (req, res) => {
  const [docs, groups] = await Promise.all([
    Student.find({}, "regNo name email createdAt face.photo face.registeredAt").sort({ createdAt: -1 }).lean(),
    Attempt.aggregate([
      { $sort: { submittedAt: -1 } },
      { $group: { _id: "$regNo", count: { $sum: 1 }, latest: { $first: "$$ROOT" } } },
    ]),
  ]);
  const grp = new Map(groups.map((g) => [g._id, g]));
  res.json({
    students: docs.map((d) => {
      const g = grp.get(d.regNo);
      const l = g ? g.latest : null;
      const registered = !!(d.face && d.face.photo);
      return {
        regNo: d.regNo,
        name: d.name,
        email: d.email,
        joinedAt: d.createdAt,
        faceRegistered: registered,
        facePhotoUrl: registered ? d.face.photo : null,
        registeredAt: registered ? d.face.registeredAt : null,
        attemptsCount: g ? g.count : 0,
        latest: l
          ? {
              submittedAt: l.submittedAt,
              testTitle: l.testTitle,
              score: l.score,
              total: l.total,
              answered: l.answered,
              strikes: l.strikes,
              risk: l.risk,
              eventCount: l.eventCount,
              reason: l.reason,
            }
          : null,
      };
    }),
  });
}));

// One student: registered face, every attempt, every violation with its snapshot, verifications and activity
app.get("/api/admin/students/:regNo", requireAdmin, wrap(async (req, res) => {
  const regNo = cleanReg(req.params.regNo);
  const doc = validReg(regNo)
    ? await Student.findOne({ regNo }, "regNo name email face.photo face.registeredAt").lean()
    : null;
  if (!doc) return res.status(404).json({ error: "Student not found" });

  const [attempts, verifications, activityLogs] = await Promise.all([
    Attempt.find({ regNo }).sort({ submittedAt: -1 }).lean(),
    Verification.find({ regNo }).sort({ verifiedAt: -1 }).limit(30).lean(),
    ActivityLog.find({ regNo }).sort({ timestamp: -1 }).limit(100).lean(),
  ]);

  const violations = attempts.length
    ? await Violation.find({ attemptId: { $in: attempts.map((a) => a._id) } }).sort({ timestamp: 1 }).lean()
    : [];
  const byAttempt = new Map();
  violations.forEach((v) => {
    const k = String(v.attemptId);
    if (!byAttempt.has(k)) byAttempt.set(k, []);
    byAttempt.get(k).push({
      type: v.kind,
      severity: v.severity,
      timestamp: v.timestamp,
      questionNo: v.questionNo,
      riskScore: v.riskScore,
      meta: v.meta,
      snapshotUrl: v.snapshot || null,
    });
  });

  // Calculate activity statistics
  let totalBlurEvents = 0;
  let totalAwaySeconds = 0;
  let totalTabSwitches = 0;
  activityLogs.forEach((log) => {
    if (log.eventType === "WINDOW_BLUR" || log.eventType === "WINDOW_FOCUS") {
      totalBlurEvents += 1;
      totalAwaySeconds += log.duration || 0;
    }
    if (log.eventType === "TAB_SWITCH" || log.eventType === "ACTIVE_TAB_CHANGED") {
      totalTabSwitches += 1;
    }
  });

  const registered = !!(doc.face && doc.face.photo);
  res.json({
    student: {
      regNo: doc.regNo,
      name: doc.name,
      email: doc.email,
      faceRegistered: registered,
      facePhotoUrl: registered ? doc.face.photo : null,
      registeredAt: registered ? doc.face.registeredAt : null,
    },
    activitySummary: {
      totalBlurEvents,
      totalAwaySeconds,
      totalTabSwitches,
      logsCount: activityLogs.length,
    },
    verifications: verifications.map((v) => ({
      id: String(v._id),
      testId: v.testId,
      testTitle: v.testTitle,
      status: v.status,
      verifiedAt: v.verifiedAt,
      distance: v.distance,
      threshold: v.threshold,
      photoUrl: v.photo || null,
      failureReason: v.failureReason,
      reviewedBy: v.reviewedBy,
      reviewedAt: v.reviewedAt,
      adminNotes: v.adminNotes,
    })),
    activityLogs: activityLogs.map((l) => ({
      id: String(l._id),
      eventType: l.eventType,
      testId: l.testId,
      testTitle: l.testTitle,
      timestamp: l.timestamp,
      tabTitle: l.tabTitle,
      tabUrl: l.tabUrl,
      duration: l.duration,
      metadata: l.metadata,
    })),
    attempts: attempts.map((a) => ({
      id: String(a._id),
      testTitle: a.testTitle,
      submittedAt: a.submittedAt,
      score: a.score,
      total: a.total,
      answered: a.answered,
      reason: a.reason,
      strikes: a.strikes,
      risk: a.risk,
      events: byAttempt.get(String(a._id)) || [],
    })),
  });
}));

// Test records tab: every submitted test (latest first), without the heavy snapshots
app.get("/api/admin/records", requireAdmin, wrap(async (req, res) => {
  const [students, attempts] = await Promise.all([
    Student.find({}, "regNo name email").lean(),
    Attempt.find().sort({ submittedAt: -1 }).limit(500).lean(),
  ]);
  const names = new Map(students.map((s) => [s.regNo, s]));
  res.json({
    records: attempts.map((a) => {
      const s = names.get(a.regNo);
      return {
        id: String(a._id),
        regNo: a.regNo,
        name: s ? s.name : "",
        email: s ? s.email : "",
        testTitle: a.testTitle,
        submittedAt: a.submittedAt,
        score: a.score,
        total: a.total,
        answered: a.answered,
        strikes: a.strikes,
        risk: a.risk,
        eventCount: a.eventCount,
        reason: a.reason,
      };
    }),
  });
}));

// Admin: View all identity verifications
app.get("/api/admin/verifications", requireAdmin, wrap(async (req, res) => {
  const list = await Verification.find().sort({ verifiedAt: -1 }).limit(100).lean();
  res.json({
    verifications: list.map((v) => ({
      id: String(v._id),
      regNo: v.regNo,
      studentName: v.studentName,
      studentEmail: v.studentEmail,
      testId: v.testId,
      testTitle: v.testTitle,
      status: v.status,
      verifiedAt: v.verifiedAt,
      distance: v.distance,
      threshold: v.threshold,
      photoUrl: v.photo || null,
      failureReason: v.failureReason,
      reviewedBy: v.reviewedBy,
      reviewedAt: v.reviewedAt,
      adminNotes: v.adminNotes,
    })),
  });
}));

// Admin: One-click approval of verification (for manual reviews or false failures)
app.post("/api/admin/verifications/:id/approve", requireAdmin, wrap(async (req, res) => {
  const ver = await Verification.findById(req.params.id);
  if (!ver) return res.status(404).json({ error: "Verification record not found" });

  ver.status = "admin_approved";
  ver.reviewedBy = req.admin.email;
  ver.reviewedAt = new Date();
  ver.adminNotes = req.body.notes || "Approved by exam supervisor";
  await ver.save();

  res.json({ ok: true, status: "admin_approved" });
}));

// Admin: View activity logs across tests and students
app.get("/api/admin/activity", requireAdmin, wrap(async (req, res) => {
  const query = {};
  if (req.query.regNo) query.regNo = cleanReg(req.query.regNo);
  if (req.query.testId) query.testId = String(req.query.testId);

  const logs = await ActivityLog.find(query).sort({ timestamp: -1 }).limit(200).lean();
  res.json({ logs });
}));

// Lets the student register the face again (for example after a wrong or poor photo)
app.post("/api/admin/students/:regNo/reset-face", requireAdmin, wrap(async (req, res) => {
  const regNo = cleanReg(req.params.regNo);
  if (!validReg(regNo)) return res.status(400).json({ error: "Invalid registration number." });
  await Student.updateOne({ regNo }, { $unset: { face: 1, session: 1 } });
  await Lock.deleteMany({ key: { $regex: "^(student|face):" + regNo + "(:|$)" } });
  res.json({ ok: true });
}));

app.delete("/api/admin/students/:regNo/results", requireAdmin, wrap(async (req, res) => {
  const regNo = cleanReg(req.params.regNo);
  if (!validReg(regNo)) return res.status(400).json({ error: "Invalid registration number." });
  const attempts = await Attempt.find({ regNo }, "_id");
  const ids = attempts.map((a) => a._id);
  await Promise.all([
    Attempt.deleteMany({ regNo }),
    Violation.deleteMany({ $or: [{ regNo }, { attemptId: { $in: ids } }] }),
  ]);
  res.json({ ok: true, deleted: ids.length });
}));

app.delete("/api/admin/students/:regNo", requireAdmin, wrap(async (req, res) => {
  const regNo = cleanReg(req.params.regNo);
  if (!validReg(regNo)) return res.status(400).json({ error: "Invalid registration number." });
  const attempts = await Attempt.find({ regNo }, "_id");
  const ids = attempts.map((a) => a._id);
  await Promise.all([
    Student.deleteOne({ regNo }),
    Lock.deleteMany({ key: { $regex: "^(student|face):" + regNo + "(:|$)" } }),
    Otp.deleteMany({ key: { $regex: "^student:" + regNo + ":" } }),
    Attempt.deleteMany({ regNo }),
    Violation.deleteMany({ $or: [{ regNo }, { attemptId: { $in: ids } }] }),
  ]);
  res.json({ ok: true });
}));
// ---------- ERRORS ----------
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err && err.message === "CORS_BLOCKED") return res.status(403).json({ error: "This origin is not allowed." });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

// ---------- START ----------
mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => {
      console.log("Smart Proctor backend running on http://localhost:" + PORT);
      console.log("Data source: " + (data.USE_AIRTABLE ? "Airtable" : "built-in demo data (Airtable keys are empty)"));
      console.log("Allowed origins: " + ORIGINS.join(", "));
      if (DEV_SHOW_OTP) console.log("DEV_SHOW_OTP is on: OTPs are returned in API responses (demo only).");
    });
  })
  .catch((err) => {
    console.error("MongoDB connection failed: " + err.message);
    console.error("Check MONGODB_URI, the database user's password, and Atlas > Network Access (add 0.0.0.0/0).");
    process.exit(1);
  });