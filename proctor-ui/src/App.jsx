import { useState, useEffect, useRef, useCallback } from "react";
import { ProctorEngine } from "./proctorEngine.js";
import { FaceMatcher } from "./faceMatch.js";
import robotImg from "./assets/robot.jpeg";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

const MAX_STRIKES = 3;
const FACE_THRESHOLD = 0.45;
const REG_NO_LENGTH = 11;

const EVENT_LABELS = {
  NO_FACE: "No face detected",
  MULTIPLE_FACES: "Multiple faces detected",
  HEAD_TURN: "Head turned sideways",
  HEAD_DOWN: "Head tilted down",
  GAZE_AWAY: "Eyes looking away",
  AUDIO_SPIKE: "Loud noise detected",
  LIVENESS_FAIL: "Liveness check failed",
  FACE_MISMATCH: "Different person detected",
  WINDOW_BLUR: "Left the exam window",
  EXTRA_DISPLAY_DETECTED: "Multiple monitors detected",
  BLOCKED_APP_DETECTED: "Unauthorized application running",
  CLIPBOARD_PASTE_BLOCKED: "Clipboard paste blocked",
  CLIPBOARD_COPY_BLOCKED: "Clipboard copy blocked",
  AI_SITE_ACTIVE: "AI assistant detected",
};

// Centralized API call helper with JSON parsing and authentication support
async function api(path, { method = "GET", body, token, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("The server took too long to respond.");
    throw new Error("Could not reach backend at " + API_BASE + ". Please ensure the server is running.");
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = await res.json(); } catch { json = null; }

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `Server returned status ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = json && json.code;
    err.data = json;
    throw err;
  }
  return json;
}

function capturePhoto(video, width = 240) {
  try {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = Math.round((width * video.videoHeight) / video.videoWidth);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.75);
  } catch {
    return null;
  }
}

const primaryBtn =
  "w-full py-3 rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-[0.98] " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-md shadow-blue-600/20";
const secondaryBtn =
  "w-full py-3 rounded-xl font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200";
const fieldBox =
  "w-full px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-900 outline-none transition " +
  "focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10 placeholder:text-slate-400";
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

// ----------------------------------------------------
// STUDENT LOGIN (OTP VIA BACKEND)
// ----------------------------------------------------
function StudentLogin({ onDone }) {
  const [step, setStep] = useState("details");
  const [name, setName] = useState("");
  const [regNo, setRegNo] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSendOtp = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError("Please enter your full name");
    if (!/^\d{4,15}$/.test(regNo)) {
      return setError("Please enter a valid registration / roll number (4 to 15 digits)");
    }
    if (!/\S+@\S+\.\S+/.test(email)) return setError("Please enter a valid email address");

    setBusy(true);
    setError("");
    try {
      await api("/api/auth/otp/send", {
        method: "POST",
        body: { name: name.trim(), regNo: regNo.trim(), email: email.trim().toLowerCase() },
      });
      setOtp("");
      setStep("otp");
    } catch (err) {
      setError(err.message || "Failed to send OTP. Please check credentials.");
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (otp.length !== 6) return setError("Please enter the 6-digit OTP");

    setBusy(true);
    setError("");
    try {
      const res = await api("/api/auth/otp/verify", {
        method: "POST",
        body: {
          name: name.trim(),
          regNo: regNo.trim(),
          email: email.trim().toLowerCase(),
          otp: otp.trim(),
        },
      });

      if (!res.token) throw new Error("No authorization token received.");

      onDone({
        student: res.student || { regNo: regNo.trim(), name: name.trim(), email: email.trim().toLowerCase() },
        token: res.token,
        faceRegistered: !!res.faceRegistered,
      });
    } catch (err) {
      setError(err.message || "Incorrect OTP. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SplitLayout>
      <div>
        <Logo />
        {window.proctor && (
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 mb-3">
            <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
            Electron Secure Lockdown Active
          </div>
        )}
        <h1 className="text-3xl font-bold text-slate-900">Student Portal</h1>
        <p className="text-slate-500 mt-1 mb-6">
          {step === "details"
            ? "Enter your Name, Registration Number & Email"
            : "Enter OTP sent to your registered email"}
        </p>

        {step === "details" ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <div>
              <label className={labelCls}>Full Name</label>
              <input
                className={fieldBox}
                placeholder="Enter your full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className={labelCls}>Registration Number / Roll No</label>
              <input
                className={fieldBox}
                placeholder="Enter roll / reg number (e.g. 12515001234)"
                maxLength={15}
                value={regNo}
                onChange={(e) => setRegNo(e.target.value.replace(/\D/g, ""))}
                required
              />
            </div>
            <div>
              <label className={labelCls}>Email Address (Any Gmail / University Email)</label>
              <input
                className={fieldBox}
                type="email"
                placeholder="Enter student email (e.g. yourname@gmail.com)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3 border border-red-200">{error}</div>}
            <button type="submit" className={primaryBtn} disabled={busy}>
              {busy ? "Sending OTP..." : "Get OTP"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-3.5 text-xs text-blue-900">
              <p className="font-semibold text-blue-950">OTP sent to your email: <b>{email}</b></p>
              <p className="text-slate-600 mt-1">Please check your email inbox (and Spam / Promotions folder) for the 6-digit verification code.</p>
            </div>
            <div>
              <label className={labelCls}>6-Digit OTP</label>
              <input
                className={`${fieldBox} tracking-[0.5em] text-center text-xl font-mono`}
                maxLength={6}
                placeholder="------"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </div>
            {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3 border border-red-200">{error}</div>}
            <button type="submit" className={primaryBtn} disabled={busy || otp.length !== 6}>
              {busy ? "Verifying..." : "Verify OTP"}
            </button>
            <button type="button" className={secondaryBtn} onClick={() => { setStep("details"); setError(""); }}>
              Back
            </button>
          </form>
        )}
      </div>
    </SplitLayout>
  );
}

// ----------------------------------------------------
// STUDENT DASHBOARD (REAL AIRTABLE TESTS & MONGODB RESULTS)
// ----------------------------------------------------
function StudentDashboard({ student, token, faceRegistered, onStartTest, onLogout }) {
  const [tests, setTests] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [testsData, resultsData] = await Promise.all([
        api("/api/tests", { token }),
        api("/api/results/me", { token }),
      ]);
      setTests(testsData.tests || []);
      setAttempts(resultsData.results || []);
    } catch (err) {
      setError(err.message || "Failed to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto flex justify-between items-center mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-slate-900">Welcome, {student.name}</h1>
            {window.proctor && (
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse" />
                Electron Active
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">
            Reg No: <span className="font-mono font-semibold">{student.regNo}</span> ·{" "}
            Face Status:{" "}
            <span className={`font-semibold ${faceRegistered ? "text-green-600" : "text-amber-600"}`}>
              {faceRegistered ? "Registered" : "Not Registered"}
            </span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadDashboardData}
            className="px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl text-sm font-medium transition"
          >
            Refresh
          </button>
          <button
            onClick={onLogout}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 rounded-xl text-sm font-medium transition"
          >
            Logout
          </button>
        </div>
      </div>

      {error && (
        <div className="max-w-4xl mx-auto mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="max-w-4xl mx-auto grid gap-6">
        {/* Available Tests from Airtable */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-slate-900">Available Tests (Airtable)</h2>
            <span className="text-xs px-2.5 py-1 bg-blue-100 text-blue-700 font-bold rounded-full">
              {tests.length} Available
            </span>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400 py-4">Loading active tests from Airtable...</p>
          ) : tests.length === 0 ? (
            <p className="text-sm text-slate-400 py-4">No active tests found in Airtable.</p>
          ) : (
            <div className="space-y-4">
              {tests.map((test) => (
                <div
                  key={test.id}
                  className="rounded-xl border border-slate-200 p-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:border-blue-300 transition"
                >
                  <div>
                    <span className="px-2.5 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded-full">
                      Live Assessment
                    </span>
                    <h3 className="text-xl font-bold text-slate-900 mt-2">{test.title}</h3>
                    <p className="text-sm text-slate-500 mt-1">
                      Duration: {Math.round(test.durationSeconds / 60)} Minutes
                      {test.totalQuestions ? ` · ${test.totalQuestions} Questions` : ""} · AI Face Proctored
                    </p>
                  </div>
                  <button
                    onClick={() => onStartTest(test)}
                    className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-md shadow-blue-600/20 transition whitespace-nowrap"
                  >
                    {faceRegistered ? "Start Test" : "Register Face & Start"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Past Attempts History from MongoDB Atlas */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Past Test Attempts (MongoDB Atlas)</h3>
          {loading ? (
            <p className="text-sm text-slate-400 py-4">Loading attempts...</p>
          ) : attempts.length === 0 ? (
            <p className="text-sm text-slate-400 py-4">No test attempts recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {attempts.map((att, idx) => (
                <div
                  key={att.id || idx}
                  className="p-4 rounded-xl border border-slate-100 bg-slate-50 flex justify-between items-center"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-800">
                      {att.testTitle || "Online Exam"} · {new Date(att.submittedAt).toLocaleString()}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Status: {att.reason || "Submitted"} · Violations: {att.violations ?? 0} · Strikes: {att.strikes ?? 0}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-blue-600">
                      {typeof att.score === "number" ? `${att.score}/${att.total}` : `${att.answered}/${att.total}`}
                    </p>
                    <p className={`text-xs font-semibold ${att.strikes > 0 ? "text-amber-600" : "text-green-600"}`}>
                      {att.strikes > 0 ? `${att.strikes} Strike(s)` : "Clean Exam"}
                    </p>
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
      {scanning && <div className="absolute left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_14px_4px_rgba(34,211,238,0.7)] animate-pulse" />}
    </div>
  );
}

// ----------------------------------------------------
// FACE GATEKEEPER (REGISTRATION & VERIFICATION VIA BACKEND)
// ----------------------------------------------------
function FaceGatekeeper({ student, token, isFaceRegistered, onComplete, onBack }) {
  const videoRef = useRef(null);
  const engineRef = useRef(null);
  const matcherRef = useRef(null);
  const [phase, setPhase] = useState("loading");
  const [msg, setMsg] = useState("Loading AI proctoring models...");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const engine = new ProctorEngine(videoRef.current, { enableAudio: false, snapshots: true });
        engineRef.current = engine;
        await engine.start();
        if (cancelled) { engine.stop(); return; }

        const matcher = new FaceMatcher({ threshold: FACE_THRESHOLD });
        await matcher.load();
        if (cancelled) return;
        matcherRef.current = matcher;

        setPhase(isFaceRegistered ? "verify" : "register");
        setMsg(
          isFaceRegistered
            ? "Look directly into the camera to verify your identity."
            : "First-time face registration: Look into the camera."
        );
      } catch (e) {
        if (!cancelled) {
          setPhase("error");
          setMsg("Failed to initialize webcam or AI models: " + e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (engineRef.current) engineRef.current.stop();
    };
  }, [isFaceRegistered]);

  const runAction = async () => {
    const matcher = matcherRef.current;
    const engine = engineRef.current;
    const video = videoRef.current;
    setPhase((p) => p + "-working");
    setError("");

    const fail = (m) => {
      setError(m);
      setPhase(isFaceRegistered ? "verify" : "register");
    };

    try {
      if (!isFaceRegistered) {
        setMsg("Capturing face landmarks reference (5 frames)...");
        const r = await matcher.enroll(video);
        if (!r.ok) return fail(r.reason || "Could not detect a clear, single face.");

        setMsg("Liveness check: Please blink twice...");
        const live = await engine.liveness({ blinks: 2, timeoutMs: 10000 });
        if (!live) return fail("Liveness check failed. Please blink visibly twice.");

        const photo = capturePhoto(video);
        if (!photo) return fail("Failed to capture face photo.");

        setMsg("Saving registered face to MongoDB...");
        const res = await api("/api/face/register", {
          method: "POST",
          token,
          body: { descriptor: matcher.getReference(), photo },
        });

        if (!res.token) throw new Error("No test session token returned.");

        engine.stop();
        setPhase("done");
        setTimeout(() => onComplete(res.token, true), 1200);
      } else {
        setMsg("Capturing live face features...");
        const r = await matcher.enroll(video);
        if (!r.ok) return fail(r.reason || "Please ensure only your face is visible.");

        setMsg("Liveness check: Please blink twice...");
        const live = await engine.liveness({ blinks: 2, timeoutMs: 10000 });
        if (!live) return fail("Liveness check failed. Please blink visibly twice.");

        setMsg("Verifying face against MongoDB database...");
        const res = await api("/api/auth/face-verify", {
          method: "POST",
          token,
          body: { descriptor: matcher.getReference() },
        });

        if (!res.match || !res.token) {
          return fail("Face did not match the registered face for this student.");
        }

        engine.stop();
        setPhase("done");
        setTimeout(() => onComplete(res.token, false), 1200);
      }
    } catch (e) {
      fail(e.message || "An error occurred during face processing.");
    }
  };

  const isWorking = phase.endsWith("-working");
  const actualPhase = phase.replace("-working", "");

  if (phase === "done") {
    return (
      <SplitLayout>
        <div className="w-14 h-14 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-2xl mb-5 font-bold">
          ✓
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Success!</h1>
        <p className="text-slate-500 mt-1 mb-5">
          {isFaceRegistered ? "Identity verified successfully." : "Face registered securely in database."}
        </p>
      </SplitLayout>
    );
  }

  return (
    <SplitLayout>
      <h1 className="text-3xl font-bold text-slate-900">
        {isFaceRegistered ? "Face Verification" : "Face Registration"}
      </h1>
      <p className="text-slate-500 mt-1 mb-5">
        {student.name} · <span className="font-mono">{student.regNo}</span>
      </p>
      <CameraFrame videoRef={videoRef} scanning={isWorking} />
      <p className={`text-center mb-3 text-sm ${isWorking ? "text-blue-600 font-medium" : "text-slate-600"}`}>
        {msg}
      </p>
      {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3 mb-3 border border-red-200">{error}</div>}
      <button
        className={primaryBtn}
        onClick={runAction}
        disabled={actualPhase === "loading" || actualPhase === "error" || isWorking}
      >
        {isWorking ? "Processing..." : isFaceRegistered ? "Verify Face & Proceed" : "Register Face & Proceed"}
      </button>
      <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack} disabled={isWorking}>
        Back to Dashboard
      </button>
    </SplitLayout>
  );
}

// ----------------------------------------------------
// CONSENT SCREEN (LOADS QUESTIONS FROM AIRTABLE)
// ----------------------------------------------------
function Consent({ student, selectedTest, testToken, onStart, onBack }) {
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState([]);
  const [duration, setDuration] = useState(selectedTest.durationSeconds || 300);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const data = await api(`/api/tests/${selectedTest.id}/questions`, { token: testToken });
        if (!active) return;
        setQuestions(data.questions || []);
        if (data.test && data.test.durationSeconds) setDuration(data.test.durationSeconds);
      } catch (err) {
        if (!active) return;
        setError(err.message || "Failed to load questions from Airtable.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [selectedTest, testToken]);

  const rules = [
    "Webcam and microphone will remain active throughout the test.",
    "Face landmarks, eye gaze direction, head movement and background audio are monitored.",
    "Multiple displays, tab switching, and unauthorized applications will trigger violations.",
    `${MAX_STRIKES} serious violations will cause automatic test submission.`,
    `This assessment contains ${questions.length} questions with a ${Math.round(duration / 60)}-minute time limit.`,
  ];

  return (
    <SplitLayout>
      <h1 className="text-3xl font-bold text-slate-900">Assessment Rules</h1>
      <p className="text-slate-500 mt-1 mb-5">
        Test: <b>{selectedTest.title}</b> · Student: {student.name}
      </p>

      {error ? (
        <div className="p-4 rounded-xl bg-red-50 text-red-700 text-sm mb-5 border border-red-200">
          {error}
        </div>
      ) : (
        <ul className="space-y-2.5 mb-5">
          {rules.map((r, i) => (
            <li key={i} className="flex gap-3 text-sm text-slate-700">
              <span className="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
                {i + 1}
              </span>
              {r}
            </li>
          ))}
        </ul>
      )}

      <label className="flex items-start gap-3 p-4 rounded-xl border border-slate-300 hover:border-blue-400 cursor-pointer mb-5">
        <input
          type="checkbox"
          className="mt-1 w-4 h-4 accent-blue-600"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          disabled={loading || questions.length === 0}
        />
        <span className="text-sm text-slate-700 font-medium">
          I understand and agree to the smart proctoring rules and monitoring terms.
        </span>
      </label>

      <button
        className={primaryBtn}
        disabled={!agreed || loading || questions.length === 0}
        onClick={() => onStart(questions, duration)}
      >
        {loading ? "Loading Questions from Airtable..." : "Start Test"}
      </button>
      <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack}>
        Back to Dashboard
      </button>
    </SplitLayout>
  );
}

// ----------------------------------------------------
// TEST SCREEN (AI MONITORING + ELECTRON IPC + SUBMISSION)
// ----------------------------------------------------
function Test({ student, selectedTest, questions, durationSeconds, testToken, onFinish }) {
  const videoRef = useRef(null);
  const engineRef = useRef(null);
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
  const [timeLeft, setTimeLeft] = useState(durationSeconds || 300);
  const [phase, setPhase] = useState("loading");
  const [live, setLive] = useState({ faces: 1, headTurn: false, headDown: false, gazeAway: false });
  const [toast, setToast] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const showToast = (msg, kind) => {
    setToast({ msg, kind, id: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  // Heartbeat to keep session alive in MongoDB
  useEffect(() => {
    const hbTimer = setInterval(() => {
      api("/api/session/heartbeat", { method: "POST", token: testToken }).catch(() => {});
    }, 25000);
    return () => clearInterval(hbTimer);
  }, [testToken]);

  // Submission handler
  finishRef.current = async (reason) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setSubmitting(true);
    if (engineRef.current) engineRef.current.stop();

    // Map given answers: { [questionId]: selectedOptionText }
    const answersMap = {};
    let answeredCount = 0;
    questions.forEach((q, i) => {
      const selectedIndex = answersRef.current[i];
      if (selectedIndex !== undefined && selectedIndex !== null) {
        answeredCount += 1;
        answersMap[String(q.id)] = q.options[selectedIndex];
      }
    });

    try {
      const res = await api("/api/test/submit", {
        method: "POST",
        token: testToken,
        body: {
          testId: selectedTest.id,
          testTitle: selectedTest.title,
          answers: answersMap,
          events: eventsRef.current,
          reason,
        },
      });

      onFinish({
        score: res.score,
        total: res.total || questions.length,
        answered: res.answered ?? answeredCount,
        reason,
        strikes: strikesRef.current,
        submittedAt: Date.now(),
      });
    } catch (err) {
      // In case of submission error, notify student
      onFinish({
        score: null,
        total: questions.length,
        answered: answeredCount,
        reason: "Submitted: " + (err.message || reason),
        strikes: strikesRef.current,
        submittedAt: Date.now(),
      });
    }
  };

  // Connect Electron IPC if inside Electron desktop app
  useEffect(() => {
    const proctor = window.proctor;
    if (!proctor) return undefined;

    const offEvent = proctor.onEvent((entry) => {
      eventsRef.current.push({
        type: entry.eventType,
        severity: entry.severity === "violation" ? "medium" : "low",
        timestamp: Date.now(),
        questionNo: currentRef.current + 1,
        riskScore: entry.severity === "violation" ? 15 : 5,
        meta: entry.details || {},
      });
      const label = EVENT_LABELS[entry.eventType] || entry.message || entry.eventType;
      if (entry.severity === "violation") {
        strikesRef.current += 1;
        showToast(`Desktop Warning: ${label}`, "warning");
        if (strikesRef.current >= MAX_STRIKES) {
          finishRef.current(`Auto-submitted after ${MAX_STRIKES} desktop violations`);
        }
      }
    });

    const offViolation = proctor.onViolation((info) => {
      if (info.limitReached) {
        finishRef.current("Auto-submitted: Desktop violation threshold reached");
      }
    });

    // Block copy / paste inside renderer and report to electron
    const blockClipboard = (type) => (e) => {
      e.preventDefault();
      proctor.reportActivity(type, {});
      showToast("Clipboard actions are restricted during test", "warning");
    };

    const onCopy = blockClipboard("CLIPBOARD_COPY_BLOCKED");
    const onCut = blockClipboard("CLIPBOARD_CUT_BLOCKED");
    const onPaste = blockClipboard("CLIPBOARD_PASTE_BLOCKED");
    const onMenu = blockClipboard("CONTEXT_MENU_BLOCKED");

    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("contextmenu", onMenu);

    return () => {
      offEvent();
      offViolation();
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("contextmenu", onMenu);
    };
  }, []);

  // Initialize ProctorEngine (MediaPipe Face Landmark + Noise detection)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const engine = new ProctorEngine(videoRef.current, {
          sessionId: "test-" + Date.now(),
          getQuestionNo: () => currentRef.current + 1,
          snapshots: true,
          onEvent: (e) => {
            eventsRef.current.push(e);
            const label = EVENT_LABELS[e.type] || e.type;
            if (e.severity === "low") {
              showToast("Notice: " + label, "notice");
            } else {
              strikesRef.current += 1;
              const n = strikesRef.current;
              showToast(`Warning ${n}/${MAX_STRIKES}: ${label}`, "warning");
              if (n >= MAX_STRIKES) {
                finishRef.current(`Auto-submitted after ${MAX_STRIKES} proctoring violations`);
              }
            }
          },
          onStatus: (s) => {
            const key = `${s.faces}-${s.headTurn}-${s.headDown}-${s.gazeAway}`;
            if (key !== lastKey.current) {
              lastKey.current = key;
              setLive({ faces: s.faces, headTurn: s.headTurn, headDown: s.headDown, gazeAway: s.gazeAway });
            }
          },
        });
        engineRef.current = engine;
        await engine.start();
        if (cancelled) { engine.stop(); return; }

        // Baseline calibration
        setPhase("calibrating");
        const ok = await engine.calibrate();
        if (cancelled) return;
        setPhase(ok ? "running" : "calfail");
      } catch (err) {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(toastTimer.current);
      if (engineRef.current) engineRef.current.stop();
    };
  }, []);

  // Countdown timer
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          finishRef.current("Time expired");
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  const pick = (optionIndex) => {
    answersRef.current = { ...answersRef.current, [current]: optionIndex };
    setAnswers({ ...answersRef.current });
  };
  const go = (i) => {
    currentRef.current = i;
    setCurrent(i);
  };

  const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");
  const q = questions[current] || { question: "Loading...", options: [] };

  let liveText = "Face OK", liveColor = "text-green-600", dotColor = "bg-green-500";
  if (live.faces === 0) { liveText = "No face!"; liveColor = "text-red-600"; dotColor = "bg-red-500"; }
  else if (live.faces > 1) { liveText = "Multiple faces!"; liveColor = "text-amber-600"; dotColor = "bg-amber-500"; }
  else if (live.headTurn || live.headDown || live.gazeAway) { liveText = "Movement warning"; liveColor = "text-amber-600"; dotColor = "bg-amber-500"; }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Initialization Modal */}
      {phase !== "running" && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-8 max-w-sm text-center shadow-2xl">
            {phase === "loading" && <p className="font-medium text-slate-700">Initializing AI Proctoring...</p>}
            {phase === "calibrating" && <p className="font-medium text-blue-600">Calibrating webcam... Look straight at the screen.</p>}
            {phase === "calfail" && (
              <>
                <p className="text-red-600 font-medium mb-3">Calibration failed. Please ensure proper lighting.</p>
                <button className={primaryBtn} onClick={() => engineRef.current.calibrate().then((ok) => setPhase(ok ? "running" : "calfail"))}>
                  Retry Calibration
                </button>
              </>
            )}
            {phase === "error" && (
              <p className="text-red-600 font-medium">Could not start proctoring engine. Check camera permissions.</p>
            )}
          </div>
        </div>
      )}

      {/* Real-time Toast Notifications */}
      {toast && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-xl z-40 font-semibold transition ${
            toast.kind === "warning" ? "bg-red-600 text-white" : "bg-amber-400 text-slate-900"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Header with Title and Countdown Timer */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex justify-between items-center">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-bold text-slate-900">{selectedTest.title}</p>
              {window.proctor && (
                <span className="text-[11px] px-2 py-0.5 bg-blue-100 text-blue-700 font-bold rounded-full flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse" />
                  Electron Shield
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">{student.name} ({student.regNo})</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs px-2.5 py-1 bg-amber-100 text-amber-800 font-bold rounded-full">
              Strikes: {strikesRef.current} / {MAX_STRIKES}
            </span>
            <span className="font-mono text-xl font-bold text-slate-800 bg-slate-100 px-3 py-1 rounded-xl">
              {mm}:{ss}
            </span>
          </div>
        </div>
      </header>

      {/* Question Area & Camera Feed */}
      <div className="max-w-6xl mx-auto p-4 grid md:grid-cols-[1fr_280px] gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <p className="text-sm text-blue-600 font-medium mb-2">
            Question {current + 1} of {questions.length}
          </p>
          <h2 className="text-xl font-semibold mb-6">{q.question}</h2>

          <div className="space-y-3">
            {q.options.map((option, idx) => (
              <button
                key={idx}
                onClick={() => pick(idx)}
                className={`w-full flex items-center gap-3 text-left p-4 rounded-xl border-2 transition ${
                  answers[current] === idx
                    ? "border-blue-600 bg-blue-50 text-blue-900 shadow-sm"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <span
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                    answers[current] === idx ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {String.fromCharCode(65 + idx)}
                </span>
                <span className="text-sm font-medium">{option}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-3 mt-8 pt-4 border-t border-slate-100">
            <button
              disabled={current === 0 || submitting}
              onClick={() => go(current - 1)}
              className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 font-medium disabled:opacity-40 transition"
            >
              Previous
            </button>
            {current < questions.length - 1 ? (
              <button
                onClick={() => go(current + 1)}
                disabled={submitting}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 font-semibold text-white ml-auto shadow-md transition"
              >
                Next
              </button>
            ) : (
              <button
                onClick={() => finishRef.current("Submitted by student")}
                disabled={submitting}
                className="px-6 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 font-semibold text-white ml-auto shadow-md transition"
              >
                {submitting ? "Submitting..." : "Submit Test"}
              </button>
            )}
          </div>
        </div>

        {/* Live Proctoring Monitor */}
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-sm">
            <video ref={videoRef} muted playsInline className="w-full rounded-xl bg-slate-900 [transform:scaleX(-1)]" />
            <div className="flex items-center justify-center gap-2 mt-3">
              <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
              <p className={`font-semibold text-xs ${liveColor}`}>{liveText}</p>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm text-xs space-y-2 text-slate-600">
            <p className="font-semibold text-slate-900">Active Monitoring</p>
            <p>• Face Landmarks & Gaze tracking</p>
            <p>• Ambient Noise & Audio spikes</p>
            <p>• Single Display verification</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// RESULT SCREEN (REAL MARKS FROM BACKEND)
// ----------------------------------------------------
function Result({ data, student, onDashboard }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8 w-full max-w-xl text-center">
        <div className="w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-3xl mx-auto mb-4 font-bold">
          ✓
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Test Submitted</h1>
        <p className="text-slate-500 mb-6">
          {student.name} · {data.reason || "Submitted successfully"}
        </p>

        <div className="rounded-2xl bg-blue-600 text-white p-6 mb-6 shadow-lg shadow-blue-600/30">
          <p className="text-blue-100 text-sm font-medium">Final Score (Evaluated by Backend)</p>
          <p className="text-5xl font-bold mt-2">
            {typeof data.score === "number" ? `${data.score} / ${data.total}` : `${data.answered} Answered`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-6 text-sm text-slate-600">
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
            <p className="text-xs text-slate-400">Total Questions</p>
            <p className="text-lg font-bold text-slate-800">{data.total}</p>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
            <p className="text-xs text-slate-400">Violations Recorded</p>
            <p className="text-lg font-bold text-slate-800">{data.strikes ?? 0}</p>
          </div>
        </div>

        <button className={primaryBtn} onClick={onDashboard}>
          Return to Dashboard
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// ROOT APPLICATION CONTROLLER
// ----------------------------------------------------
export default function App() {
  const [stage, setStage] = useState("login");
  const [student, setStudent] = useState(null);
  const [studentToken, setStudentToken] = useState("");
  const [testToken, setTestToken] = useState("");
  const [faceRegistered, setFaceRegistered] = useState(false);
  const [selectedTest, setSelectedTest] = useState(null);
  const [testQuestions, setTestQuestions] = useState([]);
  const [testDuration, setTestDuration] = useState(300);
  const [result, setResult] = useState(null);

  const handleLoginDone = ({ student: s, token, faceRegistered: fr }) => {
    setStudent(s);
    setStudentToken(token);
    setFaceRegistered(fr);
    setStage("dashboard");
  };

  const handleStartTest = (test) => {
    setSelectedTest(test);
    setStage("faceGate");
  };

  const handleFaceComplete = (generatedTestToken, newlyRegistered) => {
    setTestToken(generatedTestToken);
    if (newlyRegistered) setFaceRegistered(true);
    setStage("consent");
  };

  const handleConsentStart = (questions, duration) => {
    setTestQuestions(questions);
    setTestDuration(duration);
    setStage("test");
  };

  const handleTestFinish = (res) => {
    setResult(res);
    setStage("result");
  };

  const handleLogout = () => {
    setStudent(null);
    setStudentToken("");
    setTestToken("");
    setSelectedTest(null);
    setStage("login");
  };

  if (stage === "login") return <StudentLogin onDone={handleLoginDone} />;

  if (stage === "dashboard")
    return (
      <StudentDashboard
        student={student}
        token={studentToken}
        faceRegistered={faceRegistered}
        onStartTest={handleStartTest}
        onLogout={handleLogout}
      />
    );

  if (stage === "faceGate")
    return (
      <FaceGatekeeper
        student={student}
        token={studentToken}
        isFaceRegistered={faceRegistered}
        onComplete={handleFaceComplete}
        onBack={() => setStage("dashboard")}
      />
    );

  if (stage === "consent")
    return (
      <Consent
        student={student}
        selectedTest={selectedTest}
        testToken={testToken}
        onStart={handleConsentStart}
        onBack={() => setStage("dashboard")}
      />
    );

  if (stage === "test")
    return (
      <Test
        student={student}
        selectedTest={selectedTest}
        questions={testQuestions}
        durationSeconds={testDuration}
        testToken={testToken}
        onFinish={handleTestFinish}
      />
    );

  if (stage === "result")
    return <Result data={result} student={student} onDashboard={() => setStage("dashboard")} />;

  return null;
}