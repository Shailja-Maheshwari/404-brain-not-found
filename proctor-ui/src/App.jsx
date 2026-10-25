import { useState, useEffect, useRef } from "react";
import { ProctorEngine } from "./proctorEngine.js";
import { FaceMatcher } from "./faceMatch.js";
import robotImg from "./assets/robot.jpeg";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

const DEMO_QUESTIONS = [
  { id: 1, q: "Which hook is used to manage state in a React function component?", options: ["useEffect", "useState", "useRef", "useMemo"], answer: 1 },
  { id: 2, q: "Which HTTP method is generally used to create a new resource?", options: ["GET", "PUT", "POST", "DELETE"], answer: 2 },
  { id: 3, q: "What is the time complexity of binary search?", options: ["O(n)", "O(n log n)", "O(log n)", "O(1)"], answer: 2 },
  { id: 4, q: "Which of these is NOT a JavaScript data type?", options: ["Number", "Boolean", "Float", "String"], answer: 2 },
  { id: 5, q: "Which tag is used for the largest heading in HTML?", options: ["<h6>", "<head>", "<h1>", "<heading>"], answer: 2 },
];

const TEST_SECONDS = 300;
const MAX_STRIKES = 3;
const FACE_THRESHOLD = 0.45;
const MAX_ATTEMPTS_KEPT = 10;
const REG_NO_LENGTH = 11;
const MAX_LOGIN_ATTEMPTS = 15;
const LOCK_MINUTES = 5;

const DEMO_STUDENTS = {
  "12515001234": { name: "Priyanshi Gupta", email: "demo.student@example.com" },
  "12515005678": { name: "Student Two", email: "student.two@example.com" },
  "12515009999": { name: "Student Three", email: "student.three@example.com" },
};

const EVENT_LABELS = {
  NO_FACE: "No face detected",
  MULTIPLE_FACES: "Multiple faces detected",
  HEAD_TURN: "Head turned sideways",
  HEAD_DOWN: "Head tilted down",
  GAZE_AWAY: "Eyes looking away",
  AUDIO_SPIKE: "Loud noise detected",
  LIVENESS_FAIL: "Liveness check failed",
  FACE_MISMATCH: "Different person detected",
};

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Server took too long to respond");
    throw new Error("Could not reach the server");
  } finally {
    clearTimeout(timer);
  }
}

const AUTH_ENDPOINTS = {
  sendOtp: "/api/auth/send-otp",
  verifyOtp: "/api/auth/verify-otp",
};

const DEMO_FALLBACK = true;
const DEMO_OTP = "123456";

async function authPost(path, body) {
  let res;
  try {
    res = await fetchWithTimeout(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { offline: true, message: e.message };
  }
  if (res.status === 404 || res.status === 501) return { offline: true, message: "Endpoint not available" };
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  const denied = !!json && (json.success === false || json.verified === false);
  return { ok: res.ok && !denied, json, message: (json && (json.message || json.error)) || "" };
}

function studentFrom(json, regNo, inputName, fallbackEmail) {
  const src = (json && (json.student || json.user || json.data)) || json || {};
  const profile = loadProfile(regNo);
  const demo = DEMO_STUDENTS[regNo];
  return {
    regNo,
    name: inputName || src.name || (profile && profile.name) || (demo && demo.name) || regNo,
    email: src.email || fallbackEmail || (profile && profile.email) || (demo && demo.email) || "",
  };
}

async function sendOtp(regNo, email) {
  const r = await authPost(AUTH_ENDPOINTS.sendOtp, { registrationNumber: regNo, email });
  if (r.offline) {
    if (!DEMO_FALLBACK) return { ok: false, message: "Could not reach the server. Please try again." };
    const s = DEMO_STUDENTS[regNo];
    if (!s || s.email.toLowerCase() !== email.toLowerCase()) {
      return { ok: false, message: "The registration number and email do not match our records." };
    }
    return { ok: true, demo: true };
  }
  return { ok: r.ok, demo: false, message: r.ok ? "" : r.message || "Could not send OTP." };
}

async function verifyOtp(regNo, email, otp) {
  const r = await authPost(AUTH_ENDPOINTS.verifyOtp, { registrationNumber: regNo, email, otp });
  if (r.offline) {
    if (!DEMO_FALLBACK) return { ok: false, network: true, message: "Could not reach the server." };
    return { ok: otp === DEMO_OTP, demo: true };
  }
  return { ok: r.ok, message: r.message };
}

const refKey = (regNo) => "proctorFace:" + regNo;
function loadRef(regNo) {
  try { const s = localStorage.getItem(refKey(regNo)); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveRef(regNo, arr) {
  try { localStorage.setItem(refKey(regNo), JSON.stringify(arr)); return true; } catch { return false; }
}

const profileKey = (regNo) => "proctorProfile:" + regNo;
function loadProfile(regNo) {
  try { const s = localStorage.getItem(profileKey(regNo)); return s ? JSON.parse(s) : null; } catch { return null; }
}
function saveProfile(regNo, profile) {
  try { localStorage.setItem(profileKey(regNo), JSON.stringify(profile)); return true; } catch { return false; }
}

const resultsKey = (regNo) => "proctorResults:" + regNo;
function loadResults(regNo) {
  try { const s = JSON.parse(localStorage.getItem(resultsKey(regNo))); return Array.isArray(s) ? s : []; } catch { return []; }
}

function saveAttempt(regNo, attempt) {
  const list = [attempt, ...loadResults(regNo)].slice(0, MAX_ATTEMPTS_KEPT);
  try { localStorage.setItem(resultsKey(regNo), JSON.stringify(list)); return true; } catch { return false; }
}

const lockKey = (regNo) => "proctorLock:" + regNo;
function readLock(regNo) {
  try { const s = JSON.parse(localStorage.getItem(lockKey(regNo))); return s && typeof s === "object" ? s : { fails: 0, lockUntil: 0 }; } catch { return { fails: 0, lockUntil: 0 }; }
}
function writeLock(regNo, data) {
  try { localStorage.setItem(lockKey(regNo), JSON.stringify(data)); } catch {}
}

function activeLock(regNo) {
  const s = readLock(regNo);
  if (s.lockUntil && Date.now() >= s.lockUntil) { writeLock(regNo, { fails: 0, lockUntil: 0 }); return 0; }
  return s.lockUntil || 0;
}

function recordFailure(regNo) {
  const state = readLock(regNo);
  const fails = (state.fails || 0) + 1;
  if (fails >= MAX_LOGIN_ATTEMPTS) {
    const until = Date.now() + LOCK_MINUTES * 60 * 1000;
    writeLock(regNo, { fails: 0, lockUntil: until });
    return { lockUntil: until, left: 0 };
  }
  writeLock(regNo, { fails, lockUntil: 0 });
  return { lockUntil: 0, left: MAX_LOGIN_ATTEMPTS - fails };
}

function clearFailures(regNo) { writeLock(regNo, { fails: 0, lockUntil: 0 }); }

function capturePhoto(video, width = 240) {
  try {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = Math.round((width * video.videoHeight) / video.videoWidth);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch { return null; }
}

const fmtTime = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};
const hasScore = (a) => !!a && typeof a.score === "number";

const primaryBtn = "w-full py-3 rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-md shadow-blue-600/20";
const secondaryBtn = "w-full py-3 rounded-xl font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200";
const fieldBox = "w-full px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-900 outline-none transition focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10 placeholder:text-slate-400";
const labelCls = "block text-sm font-medium text-slate-700 mb-1.5";

function SplitLayout({ children }) {
  return (
    <div className="min-h-screen flex bg-white overflow-hidden">
      <div className="hidden md:block md:w-1/2 lg:w-[55%] relative overflow-hidden bg-slate-900">
        <img src={robotImg} alt="AI proctor" className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-blue-950/90 via-blue-950/20 to-blue-900/10" />
        <div className="absolute bottom-0 left-0 right-0 p-10 text-white">
          <p className="text-sm tracking-[0.3em] text-cyan-300 mb-2">AI POWERED</p>
          <h2 className="text-4xl font-bold leading-tight">Smart Proctor</h2>
          <p className="mt-2 text-blue-100 max-w-sm">Secure, fair and intelligent online assessments.</p>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-xl font-bold mb-5 shadow-lg shadow-blue-600/30">
      SP
    </div>
  );
}

function StudentLogin({ notice, onDone }) {
  const [step, setStep] = useState("details");
  const [name, setName] = useState("");
  const [regNo, setRegNo] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = (msg) => setError(msg);

  const handleSendOtp = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return fail("Enter your full name");
    if (!/^\d+$/.test(regNo) || regNo.length !== REG_NO_LENGTH) {
      return fail("Enter a valid " + REG_NO_LENGTH + "-digit registration number");
    }
    if (!/\S+@\S+\.\S+/.test(email)) return fail("Enter a valid email address");
    
    setBusy(true);
    try {
      const r = await sendOtp(regNo, email.trim());
      if (!r.ok) return fail(r.message || "Could not send OTP.");
      setError(""); setOtp(""); setStep("otp");
    } finally { setBusy(false); }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await verifyOtp(regNo, email.trim(), otp);
      if (!r.ok) return fail("Incorrect OTP.");
      clearFailures(regNo);
      const studentObj = studentFrom(r.json, regNo, name.trim(), email.trim());
      saveProfile(regNo, { regNo, name: name.trim(), email: email.trim() });
      onDone(studentObj);
    } finally { setBusy(false); }
  };

  return (
    <SplitLayout>
      <div>
        <Logo />
        <h1 className="text-3xl font-bold text-slate-900">Student Portal</h1>
        <p className="text-slate-500 mt-1 mb-6">{step === "details" ? "Enter your Name, Registration Number & Email" : "Enter OTP sent to your email"}</p>

        {step === "details" ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <div><label className={labelCls}>Full Name</label><input className={fieldBox} placeholder="Priyanshi Gupta" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><label className={labelCls}>Registration Number</label><input className={fieldBox} placeholder="12515001234" maxLength={REG_NO_LENGTH} value={regNo} onChange={(e) => setRegNo(e.target.value.replace(/\D/g, ""))} /></div>
            <div><label className={labelCls}>Email</label><input className={fieldBox} type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3">{error}</div>}
            <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Please wait..." : "Get OTP"}</button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <p className="text-sm text-slate-500">OTP sent to <b>{email}</b> (Demo OTP: {DEMO_OTP})</p>
            <div><label className={labelCls}>OTP Code</label><input className={`${fieldBox} tracking-[0.5em] text-center text-xl`} maxLength={6} placeholder="------" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} autoFocus /></div>
            {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3">{error}</div>}
            <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Verifying..." : "Verify OTP"}</button>
            <button type="button" className={secondaryBtn} onClick={() => setStep("details")}>Back</button>
          </form>
        )}
      </div>
    </SplitLayout>
  );
}

function StudentDashboard({ student, onStartTest, onLogout }) {
  const attempts = loadResults(student.regNo);
  const isFaceReg = !!loadRef(student.regNo);

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Welcome, {student.name}</h1>
          <p className="text-sm text-slate-500">Reg No: <span className="font-mono font-semibold">{student.regNo}</span></p>
        </div>
        <button onClick={onLogout} className="px-4 py-2 bg-slate-200 hover:bg-slate-300 rounded-xl text-sm font-medium transition">Logout</button>
      </div>

      <div className="max-w-4xl mx-auto grid gap-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded-full">Active Test</span>
            <h2 className="text-xl font-bold text-slate-900 mt-2">React & JavaScript Assessment</h2>
            <p className="text-sm text-slate-500 mt-1">Duration: 5 Minutes · 5 Questions · Face Proctored</p>
          </div>
          <button onClick={onStartTest} className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-md transition">
            {isFaceReg ? "Start Test" : "Register Face & Start"}
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Past Test Attempts History</h3>
          {attempts.length === 0 ? (
            <p className="text-sm text-slate-400">No test attempts yet.</p>
          ) : (
            <div className="space-y-3">
              {attempts.map((att, idx) => (
                <div key={idx} className="p-4 rounded-xl border border-slate-100 bg-slate-50 flex justify-between items-center">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">Attempt #{attempts.length - idx} ({new Date(att.submittedAt).toLocaleString()})</p>
                    <p className="text-xs text-slate-500">Reason: {att.reason} · Violations: {att.events ? att.events.length : 0}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-blue-600">{hasScore(att) ? `${att.score}/${att.total}` : `${att.answered}/${att.total}`}</p>
                    <p className={`text-xs font-semibold ${att.risk > 10 ? "text-red-600" : "text-green-600"}`}>{att.risk > 10 ? "Flagged" : "Clean"}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CameraFrame({ videoRef, scanning }) {
  const corner = "absolute w-6 h-6 border-blue-500 ";
  return (
    <div className="relative rounded-2xl overflow-hidden bg-slate-900 mb-4 shadow-lg">
      <video ref={videoRef} muted playsInline className="w-full aspect-video object-cover [transform:scaleX(-1)]" />
      <div className={corner + "top-3 left-3 border-t-4 border-l-4 rounded-tl-lg"} />
      <div className={corner + "top-3 right-3 border-t-4 border-r-4 rounded-tr-lg"} />
      <div className={corner + "bottom-3 left-3 border-b-4 border-l-4 rounded-bl-lg"} />
      <div className={corner + "bottom-3 right-3 border-b-4 border-r-4 rounded-br-lg"} />
      {scanning && <div className="absolute left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_14px_4px_rgba(34,211,238,0.7)]" />}
    </div>
  );
}

function FaceGatekeeper({ student, onComplete, onBack }) {
  const videoRef = useRef(null);
  const engineRef = useRef(null);
  const matcherRef = useRef(null);
  const [phase, setPhase] = useState("loading");
  const [msg, setMsg] = useState("Loading AI models...");
  const [error, setError] = useState("");
  const isRegistered = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = loadRef(student.regNo);
        isRegistered.current = !!saved;

        const engine = new ProctorEngine(videoRef.current, { enableAudio: false, snapshots: true });
        engineRef.current = engine;
        await engine.start();
        if (cancelled) { engine.stop(); return; }

        const matcher = new FaceMatcher({ threshold: FACE_THRESHOLD });
        await matcher.load();
        if (cancelled) return;

        if (saved) matcher.setReference(saved);
        matcherRef.current = matcher;

        setPhase(isRegistered.current ? "verify" : "register");
        setMsg(isRegistered.current ? "Verify your face to proceed." : "First-time face registration required.");
      } catch (e) {
        if (!cancelled) { setPhase("error"); setMsg("Camera or AI models failed to load."); }
      }
    })();
    return () => { cancelled = true; if (engineRef.current) engineRef.current.stop(); };
  }, [student]);

  const runAction = async () => {
    const matcher = matcherRef.current;
    const engine = engineRef.current;
    const video = videoRef.current;
    setPhase((p) => p + "-working");
    setError("");

    const fail = (m) => { setError(m); setPhase(isRegistered.current ? "verify" : "register"); };

    try {
      if (!isRegistered.current) {
        setMsg("Capturing face reference...");
        const r = await matcher.enroll(video);
        if (!r.ok) return fail(r.reason);

        setMsg("Blink twice for liveness check...");
        const live = await engine.liveness({ blinks: 2, timeoutMs: 10000 });
        if (!live) return fail("Liveness check failed. Blink twice.");

        const photo = capturePhoto(video);
        saveRef(student.regNo, matcher.getReference());
        const existingProf = loadProfile(student.regNo) || {};
        saveProfile(student.regNo, { ...existingProf, regNo: student.regNo, name: student.name, email: student.email, photo });
      } else {
        setMsg("Verifying face match...");
        const r = await matcher.verify(video);
        if (!r.ok || !r.match) return fail("Face match failed. Try again in good lighting.");

        setMsg("Blink twice for liveness check...");
        const live = await engine.liveness({ blinks: 2, timeoutMs: 10000 });
        if (!live) return fail("Liveness check failed.");
      }

      engine.stop();
      setPhase("done");
      setTimeout(onComplete, 1200);
    } catch (e) { fail("An error occurred during face processing."); }
  };

  const isWorking = phase.endsWith("-working");
  const actualPhase = phase.replace("-working", "");

  if (phase === "done") {
    return (
      <SplitLayout>
        <div className="w-14 h-14 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-2xl mb-5">&#10003;</div>
        <h1 className="text-3xl font-bold text-slate-900">Success!</h1>
        <p className="text-slate-500 mt-1 mb-5">{isRegistered.current ? "Face verified successfully." : "Face registered successfully."}</p>
      </SplitLayout>
    );
  }

  return (
    <SplitLayout>
      <h1 className="text-3xl font-bold text-slate-900">{isRegistered.current ? "Face Verification" : "Face Registration"}</h1>
      <p className="text-slate-500 mt-1 mb-5">{student.name} · <span className="font-mono">{student.regNo}</span></p>
      <CameraFrame videoRef={videoRef} scanning={isWorking} />
      <p className={`text-center mb-3 ${isWorking ? "text-blue-600 font-medium" : "text-slate-600"}`}>{msg}</p>
      {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3 mb-3">{error}</div>}
      <button className={primaryBtn} onClick={runAction} disabled={actualPhase === "loading" || isWorking}>
        {isWorking ? "Processing..." : isRegistered.current ? "Verify Face" : "Register Face"}
      </button>
      <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack} disabled={isWorking}>Back to Dashboard</button>
    </SplitLayout>
  );
}

function Consent({ student, qState, onStart, onBack }) {
  const [ok, setOk] = useState(false);
  const loading = qState.status !== "ready";
  const rules = [
    "Webcam and microphone will stay on during the test.",
    "Face position, head movement, eye direction, and identity are monitored.",
    "Analysis runs locally; violation logs and snapshots are saved.",
    MAX_STRIKES + " serious violations will auto-submit your test.",
    loading ? "Loading questions..." : "Test contains " + qState.list.length + " questions with a " + TEST_SECONDS / 60 + " minute limit.",
  ];

  return (
    <SplitLayout>
      <h1 className="text-3xl font-bold text-slate-900">Before you begin</h1>
      <p className="text-slate-500 mt-1 mb-5">Hello {student.name}, please read carefully.</p>
      <ul className="space-y-2.5 mb-5">
        {rules.map((r, i) => (
          <li key={i} className="flex gap-3 text-sm text-slate-700">
            <span className="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">{i + 1}</span>
            {r}
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-3 p-4 rounded-xl border border-slate-300 hover:border-blue-400 cursor-pointer mb-5">
        <input type="checkbox" className="mt-1 w-4 h-4 accent-blue-600" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span className="text-sm text-slate-700">I agree to monitoring rules and webcam access.</span>
      </label>
      <button className={primaryBtn} disabled={!ok || loading} onClick={onStart}>{loading ? "Loading..." : "Start Test"}</button>
      <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack}>Back to Dashboard</button>
    </SplitLayout>
  );
}

function Test({ student, questions, onFinish, onBack }) {
  const videoRef = useRef(null);
  const engineRef = useRef(null);
  const matcherRef = useRef(null);
  const answersRef = useRef({});
  const eventsRef = useRef([]);
  const strikesRef = useRef(0);
  const currentRef = useRef(0);
  const finishedRef = useRef(false);
  const lastKey = useRef("");
  const toastTimer = useRef(null);
  const finishRef = useRef(() => {});

  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState({});
  const [timeLeft, setTimeLeft] = useState(TEST_SECONDS);
  const [phase, setPhase] = useState("loading");
  const [idError, setIdError] = useState("");
  const [live, setLive] = useState({ faces: 1, headTurn: false, headDown: false, gazeAway: false });
  const [toast, setToast] = useState(null);

  finishRef.current = (reason) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (engineRef.current) engineRef.current.stop();
    const answersMap = {};
    let score = 0;
    let graded = true;
    let answered = 0;
    questions.forEach((qq, i) => {
      const a = answersRef.current[i];
      if (a !== undefined) { answered += 1; answersMap[String(qq.id)] = qq.options[a]; }
      if (typeof qq.answer === "number") { if (a === qq.answer) score += 1; } else graded = false;
    });

    const payload = {
      score: graded ? score : null,
      total: questions.length,
      answered,
      answersMap,
      events: eventsRef.current,
      reason,
    };

    // Also send test submit payload to backend API
    fetchWithTimeout(API_BASE + "/api/test/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationNumber: student.regNo,
        studentEmail: student.email,
        studentName: student.name,
        ...payload
      })
    }).catch((e) => console.log("Backend offline, relying on local state"));

    onFinish(payload);
  };

  const showToast = (msg, kind) => {
    setToast({ msg, kind, id: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  const calibrate = async () => {
    setPhase("calibrating");
    const ok = await engineRef.current.calibrate();
    setPhase(ok ? "running" : "calfail");
  };

  const runStartChecks = async () => {
    const matcher = matcherRef.current;
    if (matcher) {
      if (!matcher.hasReference()) { setIdError("No registered face found."); setPhase("idfail"); return; }
      setPhase("identity");
      const r = await matcher.verify(videoRef.current);
      if (!r.ok || !r.match) { setIdError("Identity check failed."); setPhase("idfail"); return; }
    }
    await calibrate();
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const engine = new ProctorEngine(videoRef.current, {
          sessionId: "session-" + Date.now(),
          getQuestionNo: () => currentRef.current + 1,
          snapshots: true,
          onEvent: (e) => {
            eventsRef.current = [...eventsRef.current, e];
            const label = EVENT_LABELS[e.type] || e.type;
            if (e.severity === "low") showToast("Notice: " + label, "notice");
            else {
              strikesRef.current += 1;
              const n = strikesRef.current;
              showToast("Warning " + n + "/" + MAX_STRIKES + ": " + label, "warning");
              if (n >= MAX_STRIKES) finishRef.current("Auto-submitted after " + MAX_STRIKES + " violations");
            }
          },
          onStatus: (s) => {
            const key = s.faces + "-" + s.headTurn + "-" + s.headDown + "-" + s.gazeAway;
            if (key !== lastKey.current) {
              lastKey.current = key;
              setLive({ faces: s.faces, headTurn: s.headTurn, headDown: s.headDown, gazeAway: s.gazeAway });
            }
          },
        });
        engineRef.current = engine;
        await engine.start();
        if (cancelled) { engine.stop(); return; }

        try {
          const matcher = new FaceMatcher({ threshold: FACE_THRESHOLD });
          await matcher.load();
          const saved = loadRef(student.regNo);
          if (saved) matcher.setReference(saved);
          matcherRef.current = matcher;
        } catch (e) {}

        if (cancelled) { engine.stop(); return; }
        await runStartChecks();
      } catch (err) { if (!cancelled) setPhase("error"); }
    })();
    return () => { cancelled = true; clearTimeout(toastTimer.current); if (engineRef.current) engineRef.current.stop(); };
  }, []);

  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) { finishRef.current("Time is up"); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  const pick = (i) => { answersRef.current = { ...answersRef.current, [current]: i }; setAnswers(answersRef.current); };
  const go = (i) => { currentRef.current = i; setCurrent(i); };

  const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");
  const q = questions[current];

  let liveText = "Face OK", liveColor = "text-green-600", dotColor = "bg-green-500";
  if (live.faces === 0) { liveText = "No face!"; liveColor = "text-red-600"; dotColor = "bg-red-500"; }
  else if (live.faces > 1) { liveText = "Multiple faces!"; liveColor = "text-amber-600"; dotColor = "bg-amber-500"; }
  else if (live.headTurn || live.headDown || live.gazeAway) { liveText = "Movement warning"; liveColor = "text-amber-600"; dotColor = "bg-amber-500"; }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {phase !== "running" && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-8 max-w-sm text-center shadow-2xl">
            {phase === "loading" && <p>Loading camera and AI models...</p>}
            {phase === "identity" && <p>Verifying identity...</p>}
            {phase === "idfail" && (
              <>
                <p className="text-red-600 mb-4">{idError}</p>
                <button className={primaryBtn} onClick={runStartChecks}>Retry</button>
                <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack}>Exit</button>
              </>
            )}
            {phase === "calibrating" && <p>Calibrating... Look straight ahead.</p>}
            {phase === "calfail" && <p className="text-red-600">Calibration failed. Fix lighting.</p>}
            {phase === "error" && <p className="text-red-600">Proctoring initialization failed.</p>}
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-xl z-40 font-semibold ${toast.kind === "warning" ? "bg-red-600 text-white" : "bg-amber-400 text-slate-900"}`}>
          {toast.msg}
        </div>
      )}

      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <div>
            <p className="font-bold">Smart Proctor Test</p>
            <p className="text-xs text-slate-500">{student.name} ({student.regNo})</p>
          </div>
          <span className="font-mono text-xl font-bold">{mm}:{ss}</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-4 grid md:grid-cols-[1fr_280px] gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <p className="text-sm text-blue-600 font-medium mb-2">Question {current + 1} of {questions.length}</p>
          <h2 className="text-xl font-semibold mb-5">{q.q}</h2>
          <div className="space-y-3">
            {q.options.map((o, i) => (
              <button
                key={i}
                onClick={() => pick(i)}
                className={`w-full flex items-center gap-3 text-left p-3.5 rounded-xl border-2 transition ${answers[current] === i ? "border-blue-600 bg-blue-50 text-blue-900" : "border-slate-200"}`}
              >
                <span className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-sm font-bold">{String.fromCharCode(65 + i)}</span>
                {o}
              </button>
            ))}
          </div>
          <div className="flex gap-3 mt-6">
            <button disabled={current === 0} onClick={() => go(current - 1)} className="px-5 py-2 rounded-xl bg-slate-100 disabled:opacity-40">Previous</button>
            {current < questions.length - 1 ? (
              <button onClick={() => go(current + 1)} className="px-5 py-2 rounded-xl bg-blue-600 text-white ml-auto">Next</button>
            ) : (
              <button onClick={() => finishRef.current("Submitted by student")} className="px-5 py-2 rounded-xl bg-green-600 text-white ml-auto">Submit</button>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-sm">
            <video ref={videoRef} muted playsInline className="w-full rounded-xl bg-slate-900 [transform:scaleX(-1)]" />
            <div className="flex items-center justify-center gap-2 mt-2">
              <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
              <p className={`font-semibold text-sm ${liveColor}`}>{liveText}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Result({ data, student, onDashboard }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8 w-full max-w-xl text-center">
        <h1 className="text-2xl font-bold text-slate-900">Test Submitted</h1>
        <p className="text-slate-500 mb-6">{student.name} · {data.reason}</p>
        <div className="rounded-2xl bg-blue-600 text-white p-6 mb-6">
          <p className="text-blue-100 text-sm">Your Score</p>
          <p className="text-5xl font-bold mt-1">{hasScore(data) ? `${data.score}/${data.total}` : `${data.answered}/${data.total} Answered`}</p>
        </div>
        <button className={primaryBtn} onClick={onDashboard}>Back to Dashboard</button>
      </div>
    </div>
  );
}

export default function App() {
  const [stage, setStage] = useState("login");
  const [student, setStudent] = useState(null);
  const [result, setResult] = useState(null);
  const [qState, setQState] = useState({ status: "idle", list: [] });

  const loadQuestions = async () => {
    setQState((s) => ({ ...s, status: "loading" }));
    try {
      const res = await fetchWithTimeout(API_BASE + "/api/questions");
      const json = await res.json();
      setQState({ status: "ready", list: json.questions || DEMO_QUESTIONS });
    } catch {
      setQState({ status: "ready", list: DEMO_QUESTIONS });
    }
  };

  useEffect(() => {
    if (stage === "consent" && qState.status === "idle") loadQuestions();
  }, [stage]);

  const handleFinish = (r) => {
    const strikes = r.events.filter((e) => e.severity !== "low").length;
    const risk = r.events.length ? r.events[r.events.length - 1].riskScore : 0;
    const submittedAt = Date.now();
    saveAttempt(student.regNo, {
      submittedAt,
      score: r.score,
      total: r.total,
      answered: r.answered,
      reason: r.reason,
      risk,
      strikes,
      events: r.events,
    });
    setResult({ ...r, strikes, risk, submittedAt });
    setStage("result");
  };

  if (stage === "login") return <StudentLogin onDone={(s) => { setStudent(s); setStage("dashboard"); }} />;
  if (stage === "dashboard") return <StudentDashboard student={student} onStartTest={() => setStage("faceGate")} onLogout={() => { setStudent(null); setStage("login"); }} />;
  if (stage === "faceGate") return <FaceGatekeeper student={student} onComplete={() => setStage("consent")} onBack={() => setStage("dashboard")} />;
  if (stage === "consent") return <Consent student={student} qState={qState} onStart={() => setStage("test")} onBack={() => setStage("dashboard")} />;
  if (stage === "test") return <Test student={student} questions={qState.list} onFinish={handleFinish} onBack={() => setStage("dashboard")} />;
  if (stage === "result") return <Result data={result} student={student} onDashboard={() => setStage("dashboard")} />;

  return null;
}