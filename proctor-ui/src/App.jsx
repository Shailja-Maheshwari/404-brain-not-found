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
// LOGIN FACE VERIFICATION (VERIFIES RETURNING STUDENTS BEFORE DASHBOARD)
// ----------------------------------------------------
function LoginFaceVerificationGate({ student, token, onComplete, onBack }) {
  const videoRef = useRef(null);
  const matcherRef = useRef(null);
  const [phase, setPhase] = useState("loading"); // loading, ready, verifying, done, failed
  const [msg, setMsg] = useState("Starting camera and loading AI face recognition...");
  const [error, setError] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState(3);

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const matcher = new FaceMatcher({ threshold: FACE_THRESHOLD });
        await matcher.load();
        if (cancelled) return;
        matcherRef.current = matcher;

        setPhase("ready");
        setMsg("Look directly into the camera to verify your identity before entering the student portal.");
      } catch (err) {
        if (!cancelled) {
          setPhase("failed");
          setError("Webcam or AI model error: " + (err.message || "Could not access camera."));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const handleVerify = async () => {
    const matcher = matcherRef.current;
    const video = videoRef.current;
    if (!video || !matcher) return;

    setPhase("verifying");
    setError("");
    setMsg("Analyzing facial features (3 frames)...");

    try {
      const r = await matcher._collect(video, 3);
      if (!r.ok) {
        setPhase("failed");
        setError(r.reason || "Could not detect a clear, single face.");
        return;
      }

      // Average descriptors across captured frames
      const avg = new Float32Array(128);
      r.descriptors.forEach((d) => d.forEach((v, i) => (avg[i] += v / r.descriptors.length)));

      setMsg("Verifying face against your registered baseline in MongoDB...");
      const res = await api("/api/auth/face-verify", {
        method: "POST",
        token,
        body: { descriptor: Array.from(avg) },
      });

      if (!res.match || !res.token) {
        throw new Error(res.error || "Face verification failed.");
      }

      setPhase("done");
      setMsg("Identity confirmed! Loading student dashboard...");
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      }
      setTimeout(() => {
        onComplete(res.token, res.faceDescriptor || Array.from(avg));
      }, 1000);
    } catch (err) {
      setPhase("failed");
      const left = typeof err.data?.attemptsLeft === "number" ? err.data.attemptsLeft : Math.max(0, attemptsLeft - 1);
      setAttemptsLeft(left);
      setError(err.message || "Face does not match the registered student profile. Login denied.");
    }
  };

  if (phase === "done") {
    return (
      <SplitLayout>
        <div className="w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-3xl mb-5 font-bold animate-bounce">
          ✓
        </div>
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200 mb-3">
          Face Verified
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Welcome Back, {student.name}!</h1>
        <p className="text-slate-500 mt-2 mb-6">
          Identity matched with registered baseline. Entering examination dashboard...
        </p>
        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div className="bg-green-600 h-2 rounded-full animate-pulse w-full" />
        </div>
      </SplitLayout>
    );
  }

  return (
    <SplitLayout>
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 mb-3">
        <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
        Step 2: Login Face Verification
      </div>
      <h1 className="text-3xl font-bold text-slate-900">Verify Your Identity</h1>
      <p className="text-slate-500 mt-1 mb-4 text-sm">
        {student.name} · <span className="font-mono">{student.regNo}</span>
      </p>

      <CameraFrame videoRef={videoRef} scanning={phase === "verifying"} />

      <p className={`text-center mb-3 text-sm ${phase === "verifying" ? "text-blue-600 font-semibold animate-pulse" : "text-slate-600"}`}>
        {msg}
      </p>

      {error && (
        <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3 mb-4 border border-red-200 text-left">
          <p className="font-semibold text-red-900 mb-0.5">Verification Mismatch</p>
          <p>{error}</p>
          <p className="mt-1 font-semibold text-red-800">
            {attemptsLeft > 0 ? `Attempts Remaining: ${attemptsLeft}` : "Access blocked due to failed face verification."}
          </p>
        </div>
      )}

      <button
        className={primaryBtn}
        onClick={handleVerify}
        disabled={phase === "loading" || phase === "verifying" || (phase === "failed" && attemptsLeft <= 0)}
      >
        {phase === "verifying" ? "Comparing Face..." : phase === "failed" ? "Retry Face Verification" : "Verify Face to Login"}
      </button>

      <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack} disabled={phase === "verifying"}>
        Cancel &amp; Return to Login
      </button>
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
// ----------------------------------------------------
// FIRST-TIME FACE REGISTRATION (ENROLLS ONCE INTO MONGODB)
// ----------------------------------------------------
function FaceRegistrationGate({ student, token, onComplete, onBack }) {
  const videoRef = useRef(null);
  const engineRef = useRef(null);
  const matcherRef = useRef(null);
  const [phase, setPhase] = useState("loading");
  const [msg, setMsg] = useState("Initializing camera and AI models...");
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

        setPhase("ready");
        setMsg("Look directly into the camera to register your baseline face.");
      } catch (e) {
        if (!cancelled) {
          setPhase("error");
          setError("Webcam or AI model error: " + e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (engineRef.current) engineRef.current.stop();
    };
  }, []);

  const handleRegister = async () => {
    const matcher = matcherRef.current;
    const engine = engineRef.current;
    const video = videoRef.current;
    setPhase("working");
    setError("");

    try {
      setMsg("Capturing facial landmarks (5 frames)...");
      const r = await matcher.enroll(video);
      if (!r.ok) {
        setError(r.reason || "Could not detect a clear, single face.");
        setPhase("ready");
        return;
      }

      setMsg("Liveness check: Please blink twice visibly...");
      const live = await engine.liveness({ blinks: 2, timeoutMs: 10000 });
      if (!live) {
        setError("Liveness check failed. Please blink visibly twice.");
        setPhase("ready");
        return;
      }

      const photo = capturePhoto(video);
      if (!photo) {
        setError("Could not capture webcam snapshot.");
        setPhase("ready");
        return;
      }

      setMsg("Saving registered face securely to MongoDB...");
      const res = await api("/api/face/register", {
        method: "POST",
        token,
        body: { descriptor: matcher.getReference(), photo },
      });

      if (!res.token) throw new Error("No session token returned.");

      engine.stop();
      setPhase("done");
      setTimeout(() => onComplete(res.token, matcher.getReference()), 1000);
    } catch (e) {
      setError(e.message || "Registration failed.");
      setPhase("ready");
    }
  };

  if (phase === "done") {
    return (
      <SplitLayout>
        <div className="w-14 h-14 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-2xl mb-5 font-bold">
          ✓
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Registration Complete!</h1>
        <p className="text-slate-500 mt-1 mb-5">Your baseline face has been enrolled securely. Proceeding to student dashboard...</p>
      </SplitLayout>
    );
  }

  return (
    <SplitLayout>
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 mb-3">
        Step 1: One-Time Face Registration
      </div>
      <h1 className="text-3xl font-bold text-slate-900">Face Registration</h1>
      <p className="text-slate-500 mt-1 mb-5">
        {student.name} · <span className="font-mono">{student.regNo}</span>
      </p>
      <CameraFrame videoRef={videoRef} scanning={phase === "working"} />
      <p className={`text-center mb-3 text-sm ${phase === "working" ? "text-blue-600 font-medium" : "text-slate-600"}`}>
        {msg}
      </p>
      {error && <div className="rounded-xl bg-red-50 text-red-700 text-sm p-3 mb-3 border border-red-200">{error}</div>}
      <button
        className={primaryBtn}
        onClick={handleRegister}
        disabled={phase !== "ready"}
      >
        {phase === "working" ? "Registering Face..." : "Register Face & Continue"}
      </button>
      <button className="w-full mt-3 text-sm text-slate-500 underline" onClick={onBack} disabled={phase === "working"}>
        Back to Dashboard
      </button>
    </SplitLayout>
  );
}

// ----------------------------------------------------
// TEST IDENTITY RE-VERIFICATION BEFORE EVERY TEST
// ----------------------------------------------------
function TestIdentityGate({ student, selectedTest, token, onVerified, onBack }) {
  const videoRef = useRef(null);
  const engineRef = useRef(null);
  const matcherRef = useRef(null);
  const pollTimerRef = useRef(null);

  const [phase, setPhase] = useState("loading"); // loading, ready, verifying, passed, failed, pending_review, submitting_review
  const [msg, setMsg] = useState("Starting webcam and loading AI models...");
  const [error, setError] = useState("");
  const [retriesLeft, setRetriesLeft] = useState(3);
  const [verificationId, setVerificationId] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [matchScore, setMatchScore] = useState(null);

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

        setPhase("ready");
        setMsg("Look directly into the camera to verify your identity before starting this test.");
      } catch (e) {
        if (!cancelled) {
          setPhase("error");
          setError("Failed to initialize camera or models: " + e.message);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (engineRef.current) engineRef.current.stop();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const handleVerifyAndStart = async () => {
    if (!agreed) {
      return setError("Please accept the proctoring rules before starting the exam.");
    }
    const matcher = matcherRef.current;
    const engine = engineRef.current;
    const video = videoRef.current;

    setPhase("verifying");
    setError("");
    setMsg("Aligning face and capturing descriptors (5 frames)...");

    try {
      const r = await matcher.enroll(video);
      if (!r.ok) {
        setPhase("failed");
        setError(r.reason || "Please ensure only your face is visible in the frame.");
        return;
      }

      setMsg("Liveness check: Please blink twice visibly...");
      const live = await engine.liveness({ blinks: 2, timeoutMs: 9000 });
      if (!live) {
        setPhase("failed");
        setError("Liveness check failed. Please blink visibly twice.");
        return;
      }

      const photo = capturePhoto(video);
      if (!photo) {
        setPhase("failed");
        setError("Could not capture webcam snapshot. Check camera permissions.");
        return;
      }

      setMsg("Verifying face match against registered profile in MongoDB...");
      const res = await api(`/api/tests/${selectedTest.id}/verify-identity`, {
        method: "POST",
        token,
        body: {
          descriptor: matcher.getReference(),
          photo,
          testTitle: selectedTest.title,
        },
      });

      if (!res.match || !res.token) {
        throw new Error(res.error || "Identity check failed.");
      }

      // Success!
      setPhase("passed");
      setMatchScore(res.verification ? Math.round((1 - (res.verification.distance || 0)) * 100) : 98);
      setMsg("Identity confirmed! Loading questions from Airtable/MongoDB...");

      // Fetch questions using the verified test session token
      const questionsData = await api(`/api/tests/${selectedTest.id}/questions`, { token: res.token });
      const questions = questionsData.questions || [];
      const duration = questionsData.test?.durationSeconds || selectedTest.durationSeconds || 300;

      if (questions.length === 0) {
        throw new Error("This test does not have any questions available yet.");
      }

      if (engineRef.current) engineRef.current.stop();

      setTimeout(() => {
        onVerified(res.token, questions, duration, res.faceDescriptor || matcher.getReference());
      }, 1200);

    } catch (err) {
      setPhase("failed");
      const left = typeof err.data?.retriesLeft === "number" ? err.data.retriesLeft : Math.max(0, retriesLeft - 1);
      setRetriesLeft(left);
      if (err.data?.verificationId) setVerificationId(err.data.verificationId);
      setError(err.message || "Face identity verification failed. Your face did not match the registered profile.");
    }
  };

  // Request supervisor / admin review if verification fails
  const handleRequestReview = async () => {
    if (!verificationId) {
      return setError("No verification record found to review. Please try verifying again.");
    }
    setPhase("submitting_review");
    setError("");
    try {
      await api(`/api/tests/${selectedTest.id}/request-review`, {
        method: "POST",
        token,
        body: { verificationId, reason: "Face verification mismatch - student requested supervisor approval" },
      });

      setPhase("pending_review");
      setMsg("Review request submitted. Waiting for admin approval...");

      // Poll verification status every 3 seconds
      pollTimerRef.current = setInterval(async () => {
        try {
          const statusRes = await api(`/api/tests/${selectedTest.id}/verification-status/${verificationId}`, { token });
          if (statusRes.status === "admin_approved" && statusRes.token) {
            clearInterval(pollTimerRef.current);
            setPhase("passed");
            setMsg("Admin approved your identity! Loading exam questions...");

            const questionsData = await api(`/api/tests/${selectedTest.id}/questions`, { token: statusRes.token });
            const questions = questionsData.questions || [];
            const duration = questionsData.test?.durationSeconds || selectedTest.durationSeconds || 300;

            if (engineRef.current) engineRef.current.stop();
            setTimeout(() => {
              onVerified(statusRes.token, questions, duration, statusRes.faceDescriptor);
            }, 1000);
          }
        } catch {}
      }, 3000);
    } catch (err) {
      setPhase("failed");
      setError(err.message || "Failed to submit review request.");
    }
  };

  if (phase === "passed") {
    return (
      <SplitLayout>
        <div className="w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-3xl mb-5 font-bold animate-bounce">
          ✓
        </div>
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200 mb-3">
          Identity Verified {matchScore ? `· ${matchScore}% Match` : ""}
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Identity Confirmed!</h1>
        <p className="text-slate-600 mt-2 mb-6">
          Verified for <b>{selectedTest.title}</b>. Launching exam environment...
        </p>
        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div className="bg-green-600 h-2 rounded-full animate-pulse w-full" />
        </div>
      </SplitLayout>
    );
  }

  if (phase === "pending_review") {
    return (
      <SplitLayout>
        <div className="w-16 h-16 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-2xl mb-5 font-bold animate-pulse">
          ⏳
        </div>
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 mb-3">
          Supervisor Review Pending
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Awaiting Admin Approval</h1>
        <p className="text-slate-600 mt-2 mb-4 text-sm leading-relaxed">
          Your live webcam photo has been submitted to the examination supervisor for manual identity confirmation.
        </p>
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs mb-6 text-left">
          <p className="font-semibold mb-1">Please keep this window open.</p>
          <p className="text-amber-700">As soon as the supervisor clicks <b>Approve</b> in the Admin Portal, your exam will start automatically.</p>
        </div>
        <div className="flex items-center justify-center gap-2 text-sm text-slate-500 mb-4">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
          Checking approval status every 3 seconds...
        </div>
        <button className="w-full text-sm text-slate-500 underline" onClick={onBack}>
          Cancel &amp; Return to Dashboard
        </button>
      </SplitLayout>
    );
  }

  return (
    <SplitLayout>
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 mb-3">
        <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
        Mandatory Pre-Test Identity Check
      </div>
      <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Face Verification</h1>
      <p className="text-slate-500 mt-1 mb-4 text-sm">
        Assessment: <b>{selectedTest.title}</b> · Student: {student.name} ({student.regNo})
      </p>

      <CameraFrame videoRef={videoRef} scanning={phase === "verifying"} />

      <p className={`text-center mb-3 text-sm ${phase === "verifying" ? "text-blue-600 font-semibold animate-pulse" : "text-slate-600"}`}>
        {msg}
      </p>

      {error && (
        <div className="rounded-xl bg-red-50 text-red-700 text-xs sm:text-sm p-3.5 mb-4 border border-red-200 text-left">
          <p className="font-semibold text-red-900 mb-0.5">Verification Failed</p>
          <p>{error}</p>
          <p className="mt-1 font-semibold text-red-800">
            {retriesLeft > 0 ? `Attempts Remaining: ${retriesLeft} of 3` : "Maximum retry attempts exhausted."}
          </p>
        </div>
      )}

      {/* Proctoring Rules Agreement */}
      <label className="flex items-start gap-2.5 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer mb-4 text-left">
        <input
          type="checkbox"
          className="mt-0.5 w-4 h-4 accent-blue-600"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          disabled={phase === "verifying"}
        />
        <span className="text-xs text-slate-700 leading-snug">
          I agree to the exam proctoring rules: webcam and mic will be monitored, and leaving the window will trigger violations (maximum {MAX_STRIKES} strikes).
        </span>
      </label>

      {/* Action Buttons */}
      <div className="space-y-2.5">
        <button
          className={primaryBtn}
          onClick={handleVerifyAndStart}
          disabled={phase === "loading" || phase === "verifying" || !agreed || (phase === "failed" && retriesLeft <= 0)}
        >
          {phase === "verifying" ? "Verifying Face..." : phase === "failed" ? "Retry Face Verification" : "Verify Face & Start Test"}
        </button>

        {phase === "failed" && (
          <button
            type="button"
            className="w-full py-2.5 rounded-xl font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 transition text-sm flex items-center justify-center gap-1.5"
            onClick={handleRequestReview}
          >
            <span>Request Supervisor / Admin Review</span>
          </button>
        )}

        <button
          className="w-full mt-2 text-sm text-slate-500 underline"
          onClick={onBack}
          disabled={phase === "verifying"}
        >
          Back to Dashboard
        </button>
      </div>
    </SplitLayout>
  );
}

// ----------------------------------------------------
// TEST SCREEN (AI MONITORING + ELECTRON IPC + CONTINUOUS FACE VERIFICATION + AUTO-PAUSE)
// ----------------------------------------------------
function Test({ student, selectedTest, questions, durationSeconds, testToken, faceDescriptor, onFinish }) {
  const videoRef = useRef(null);
  const modalVideoRef = useRef(null);
  const engineRef = useRef(null);
  const faceMatcherRef = useRef(null);
  const faceDescriptorRef = useRef(faceDescriptor);
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

  // In-test auto-pause state
  const [isPaused, setIsPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState(null); // FACE_MISMATCH, NO_FACE, MULTIPLE_FACES
  const [pauseDetail, setPauseDetail] = useState("");
  const [pauseDistance, setPauseDistance] = useState(null);
  const isPausedRef = useRef(false);
  const mismatchStreakRef = useRef(0);
  const noFaceStreakRef = useRef(0);
  const multiFaceStreakRef = useRef(0);
  const matchStreakRef = useRef(0);
  const pauseStartRef = useRef(null);

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

  // Load FaceMatcher with student baseline for continuous in-test verification
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let descriptor = faceDescriptorRef.current;
        if (!descriptor || descriptor.length !== 128) {
          const refRes = await api("/api/face/reference", { token: testToken }).catch(() => null);
          if (refRes && refRes.descriptor) {
            descriptor = refRes.descriptor;
            faceDescriptorRef.current = descriptor;
          }
        }
        if (!descriptor) return;

        const matcher = new FaceMatcher({ threshold: FACE_THRESHOLD });
        await matcher.load();
        if (cancelled) return;
        matcher.setReference(descriptor);
        faceMatcherRef.current = matcher;
      } catch (err) {
        console.warn("Could not initialize continuous face matcher:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
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

  // Exam pause trigger
  const triggerPause = useCallback((reason, detail, distance = null) => {
    if (isPausedRef.current || finishedRef.current) return;
    isPausedRef.current = true;
    setIsPaused(true);
    setPauseReason(reason);
    setPauseDetail(detail);
    setPauseDistance(distance);
    pauseStartRef.current = Date.now();

    const photo = videoRef.current ? capturePhoto(videoRef.current) : null;
    api("/api/test/activity", {
      method: "POST",
      token: testToken,
      body: {
        testId: selectedTest.id,
        testTitle: selectedTest.title,
        eventType: reason,
        duration: 0,
        tabTitle: document.title,
        tabUrl: window.location.href,
        metadata: { reason: detail, distance, snapshot: photo },
      },
    }).catch(() => {});

    eventsRef.current.push({
      type: reason,
      severity: "high",
      timestamp: Date.now(),
      questionNo: currentRef.current + 1,
      riskScore: 35,
      meta: { reason: detail, distance },
    });

    strikesRef.current += 1;
    const n = strikesRef.current;
    showToast(`Warning ${n}/${MAX_STRIKES}: Exam Paused - ${EVENT_LABELS[reason] || reason}`, "warning");

    if (n >= MAX_STRIKES) {
      finishRef.current(`Auto-submitted: Reached maximum ${MAX_STRIKES} proctoring violations (${reason})`);
    }
  }, [selectedTest, testToken]);

  // Exam unpause / auto-resume trigger
  const resumeExam = useCallback(() => {
    if (!isPausedRef.current || finishedRef.current) return;
    const pausedDuration = pauseStartRef.current ? Math.round((Date.now() - pauseStartRef.current) / 1000) : 0;

    api("/api/test/activity", {
      method: "POST",
      token: testToken,
      body: {
        testId: selectedTest.id,
        testTitle: selectedTest.title,
        eventType: "EXAM_RESUMED",
        duration: pausedDuration,
        tabTitle: document.title,
        tabUrl: window.location.href,
        metadata: { previousPauseReason: pauseReason, pausedSeconds: pausedDuration },
      },
    }).catch(() => {});

    isPausedRef.current = false;
    setIsPaused(false);
    setPauseReason(null);
    setPauseDetail("");
    setPauseDistance(null);
    pauseStartRef.current = null;
    showToast("Registered face confirmed! Exam resumed.", "notice");
  }, [selectedTest, testToken, pauseReason]);

  // Continuous in-test face verification against registered baseline
  useEffect(() => {
    if (phase !== "running") return;
    let running = true;

    const intervalId = setInterval(async () => {
      if (!running || finishedRef.current) return;
      const video = videoRef.current;
      const matcher = faceMatcherRef.current;
      if (!video || !matcher || !matcher.hasReference()) return;

      try {
        const result = await matcher.check(video);
        if (!result.ok) return;

        if (result.faces === 0) {
          noFaceStreakRef.current += 1;
          matchStreakRef.current = 0;
          mismatchStreakRef.current = 0;
          multiFaceStreakRef.current = 0;

          if (noFaceStreakRef.current >= 4 && !isPausedRef.current) {
            triggerPause("NO_FACE", "No face detected in webcam view. Please face the camera.");
          }
        } else if (result.faces > 1) {
          multiFaceStreakRef.current += 1;
          matchStreakRef.current = 0;
          mismatchStreakRef.current = 0;
          noFaceStreakRef.current = 0;

          if (multiFaceStreakRef.current >= 2 && !isPausedRef.current) {
            triggerPause("MULTIPLE_FACES", "Multiple faces detected. Only the registered student may take this exam.");
          }
        } else if (result.faces === 1) {
          noFaceStreakRef.current = 0;
          multiFaceStreakRef.current = 0;

          if (result.match === false) {
            // FACE MISMATCH: A different person is in front of the camera!
            mismatchStreakRef.current += 1;
            matchStreakRef.current = 0;

            if (mismatchStreakRef.current >= 2 && !isPausedRef.current) {
              triggerPause(
                "FACE_MISMATCH",
                `Different person detected! Live webcam does not match registered face for ${student.name}.`,
                result.distance
              );
            }
          } else {
            // REGISTERED STUDENT FACE MATCHED!
            mismatchStreakRef.current = 0;
            matchStreakRef.current += 1;

            if (isPausedRef.current && matchStreakRef.current >= 2) {
              resumeExam();
            }
          }
        }
      } catch {
        // Ignore single dropped frame
      }
    }, 1800);

    return () => {
      running = false;
      clearInterval(intervalId);
    };
  }, [phase, student, triggerPause, resumeExam]);

  // Examination activity tracking (Window blur/focus, duration away, tab switches)
  useEffect(() => {
    let blurTimestamp = null;

    const logActivity = (eventType, duration = 0, meta = {}) => {
      api("/api/test/activity", {
        method: "POST",
        token: testToken,
        body: {
          testId: selectedTest.id,
          testTitle: selectedTest.title,
          eventType,
          duration,
          tabTitle: document.title,
          tabUrl: window.location.href,
          metadata: meta,
        },
      }).catch(() => {});
    };

    const handleBlur = () => {
      blurTimestamp = Date.now();
      logActivity("WINDOW_BLUR", 0, { timestamp: blurTimestamp });
    };

    const handleFocus = () => {
      if (blurTimestamp) {
        const awaySec = Math.round((Date.now() - blurTimestamp) / 1000);
        blurTimestamp = null;
        logActivity("WINDOW_FOCUS", awaySec, { awaySeconds: awaySec });
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        blurTimestamp = Date.now();
        logActivity("TAB_SWITCH", 0, { hidden: true });
      } else if (blurTimestamp) {
        const awaySec = Math.round((Date.now() - blurTimestamp) / 1000);
        blurTimestamp = null;
        logActivity("WINDOW_FOCUS", awaySec, { awaySeconds: awaySec });
      }
    };

    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [selectedTest, testToken]);

  // Connect Electron IPC if inside Electron desktop app
  useEffect(() => {
    const proctor = window.proctor;
    if (!proctor) return undefined;

    const offEvent = proctor.onEvent((entry) => {
      api("/api/test/activity", {
        method: "POST",
        token: testToken,
        body: {
          testId: selectedTest.id,
          testTitle: selectedTest.title,
          eventType: entry.eventType,
          duration: entry.details?.awaySeconds || 0,
          tabTitle: document.title,
          tabUrl: window.location.href,
          metadata: entry.details || {},
        },
      }).catch(() => {});

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

  // Countdown timer (STOPS / FROZEN whenever exam is paused!)
  useEffect(() => {
    if (phase !== "running" || isPaused) return;
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
  }, [phase, isPaused]);

  // Keep modal video stream synchronized
  useEffect(() => {
    if (isPaused && modalVideoRef.current && videoRef.current && videoRef.current.srcObject) {
      modalVideoRef.current.srcObject = videoRef.current.srcObject;
      modalVideoRef.current.play().catch(() => {});
    }
  }, [isPaused]);

  const pick = (optionIndex) => {
    if (isPaused || submitting) return;
    answersRef.current = { ...answersRef.current, [current]: optionIndex };
    setAnswers({ ...answersRef.current });
  };
  const go = (i) => {
    if (isPaused || submitting) return;
    currentRef.current = i;
    setCurrent(i);
  };

  const mm = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");
  const q = questions[current] || { question: "Loading...", options: [] };

  let liveText = "Face OK", liveColor = "text-green-600", dotColor = "bg-green-500";
  if (isPaused) {
    liveText = pauseReason === "FACE_MISMATCH" ? "Face Mismatch!" : "Exam Paused";
    liveColor = "text-red-600 font-bold";
    dotColor = "bg-red-500 animate-ping";
  } else if (live.faces === 0) {
    liveText = "No face!"; liveColor = "text-red-600"; dotColor = "bg-red-500";
  } else if (live.faces > 1) {
    liveText = "Multiple faces!"; liveColor = "text-amber-600"; dotColor = "bg-amber-500";
  } else if (live.headTurn || live.headDown || live.gazeAway) {
    liveText = "Movement warning"; liveColor = "text-amber-600"; dotColor = "bg-amber-500";
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 relative">
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

      {/* FULL-SCREEN LOCKDOWN OVERLAY WHEN EXAM IS PAUSED */}
      {isPaused && (
        <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-red-500 rounded-3xl p-6 sm:p-8 max-w-lg w-full text-center shadow-2xl shadow-red-950/80 relative overflow-hidden text-white">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-red-600 via-amber-400 to-red-600 animate-pulse" />

            <div className="w-16 h-16 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 flex items-center justify-center text-3xl mx-auto mb-4 font-bold animate-bounce">
              ⚠️
            </div>

            <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/30 mb-3">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
              Exam Paused · Strike {strikesRef.current} of {MAX_STRIKES}
            </div>

            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
              {pauseReason === "FACE_MISMATCH"
                ? "Unauthorized Face Detected!"
                : pauseReason === "NO_FACE"
                ? "No Face Detected!"
                : "Multiple Faces Detected!"}
            </h2>

            <p className="text-slate-300 text-sm mb-5 leading-relaxed">
              {pauseDetail ||
                (pauseReason === "FACE_MISMATCH"
                  ? `A different face was detected. Only registered student ${student.name} (${student.regNo}) is authorized to take this test.`
                  : "Please ensure your face is clearly visible directly in front of the camera.")}
            </p>

            {/* Embedded Live Webcam inside Lockdown Modal */}
            <div className="relative rounded-2xl overflow-hidden bg-black border border-slate-700 mb-5 max-w-sm mx-auto shadow-inner">
              <video
                ref={modalVideoRef}
                muted
                playsInline
                className="w-full aspect-video object-cover [transform:scaleX(-1)]"
              />
              <div className="absolute inset-0 border-2 border-red-500/70 pointer-events-none rounded-2xl" />
              <div className="absolute top-3 left-3 w-4 h-4 border-t-2 border-l-2 border-red-400" />
              <div className="absolute top-3 right-3 w-4 h-4 border-t-2 border-r-2 border-red-400" />
              <div className="absolute bottom-3 left-3 w-4 h-4 border-b-2 border-l-2 border-red-400" />
              <div className="absolute bottom-3 right-3 w-4 h-4 border-b-2 border-r-2 border-red-400" />
              <div className="absolute left-0 right-0 h-0.5 bg-red-400/80 shadow-[0_0_12px_rgba(248,113,113,1)] animate-pulse" />
            </div>

            <div className="p-3.5 rounded-xl bg-slate-800/80 border border-slate-700 text-left text-xs text-slate-300 space-y-1.5 mb-5">
              <div className="flex items-center gap-2 text-cyan-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                Continuous Face Matching Active
              </div>
              <p className="text-slate-400">
                • <b>Timer Frozen:</b> Countdown timer is paused. You will not lose exam time while paused.
              </p>
              <p className="text-slate-400">
                • <b>Auto-Resume:</b> Look directly at the camera. The exam will automatically unpause as soon as <b>{student.name}</b>'s registered face is recognized.
              </p>
            </div>

            <div className="flex items-center justify-center gap-2 text-xs text-amber-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              Looking for registered student face... Match to resume exam.
            </div>
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
            <span className={`font-mono text-xl font-bold px-3 py-1 rounded-xl ${isPaused ? "bg-red-100 text-red-700 animate-pulse" : "bg-slate-100 text-slate-800"}`}>
              {mm}:{ss} {isPaused ? "(PAUSED)" : ""}
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
                disabled={isPaused || submitting}
                className={`w-full flex items-center gap-3 text-left p-4 rounded-xl border-2 transition ${
                  answers[current] === idx
                    ? "border-blue-600 bg-blue-50 text-blue-900 shadow-sm"
                    : "border-slate-200 hover:border-slate-300"
                } ${isPaused ? "opacity-50 cursor-not-allowed" : ""}`}
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
              disabled={current === 0 || submitting || isPaused}
              onClick={() => go(current - 1)}
              className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 font-medium disabled:opacity-40 transition"
            >
              Previous
            </button>
            {current < questions.length - 1 ? (
              <button
                onClick={() => go(current + 1)}
                disabled={submitting || isPaused}
                className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 font-semibold text-white ml-auto shadow-md transition disabled:opacity-40"
              >
                Next
              </button>
            ) : (
              <button
                onClick={() => finishRef.current("Submitted by student")}
                disabled={submitting || isPaused}
                className="px-6 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 font-semibold text-white ml-auto shadow-md transition disabled:opacity-40"
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
            <p>• Continuous Face Recognition (1:1 Registered Match)</p>
            <p>• Auto-Pause on Face Mismatch</p>
            <p>• Landmarks, Gaze & Ambient Audio</p>
            <p>• Single Display Verification</p>
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
  const [registeredFaceDescriptor, setRegisteredFaceDescriptor] = useState(null);
  const [selectedTest, setSelectedTest] = useState(null);
  const [testQuestions, setTestQuestions] = useState([]);
  const [testDuration, setTestDuration] = useState(300);
  const [result, setResult] = useState(null);

  const handleLoginDone = ({ student: s, token, faceRegistered: fr }) => {
    setStudent(s);
    setStudentToken(token);
    setFaceRegistered(fr);
    if (!fr) {
      // First-time student -> Must register face (registered only ONCE)
      setStage("registerFace");
    } else {
      // Returning student -> Must verify face before entering dashboard
      setStage("loginFaceVerify");
    }
  };

  const handleRegisterDone = (newToken, descriptor) => {
    setFaceRegistered(true);
    setStudentToken(newToken);
    if (descriptor) setRegisteredFaceDescriptor(descriptor);
    setStage("dashboard");
  };

  const handleLoginFaceVerified = (verifiedToken, descriptor) => {
    setStudentToken(verifiedToken);
    if (descriptor) setRegisteredFaceDescriptor(descriptor);
    setStage("dashboard");
  };

  const handleStartTest = (test) => {
    setSelectedTest(test);
    if (!faceRegistered) {
      setStage("registerFace");
    } else {
      // Mandatory pre-test identity re-verification before exam start
      setStage("verifyIdentity");
    }
  };

  const handleIdentityVerified = (verifiedTestToken, questions, duration, descriptor) => {
    setTestToken(verifiedTestToken);
    setTestQuestions(questions);
    setTestDuration(duration);
    if (descriptor) setRegisteredFaceDescriptor(descriptor);
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
    setRegisteredFaceDescriptor(null);
    setSelectedTest(null);
    setStage("login");
  };

  if (stage === "login") return <StudentLogin onDone={handleLoginDone} />;

  if (stage === "registerFace")
    return (
      <FaceRegistrationGate
        student={student}
        token={studentToken}
        onComplete={handleRegisterDone}
        onBack={() => setStage("login")}
      />
    );

  if (stage === "loginFaceVerify")
    return (
      <LoginFaceVerificationGate
        student={student}
        token={studentToken}
        onComplete={handleLoginFaceVerified}
        onBack={() => setStage("login")}
      />
    );

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

  if (stage === "verifyIdentity")
    return (
      <TestIdentityGate
        student={student}
        selectedTest={selectedTest}
        token={studentToken}
        onVerified={handleIdentityVerified}
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
        faceDescriptor={registeredFaceDescriptor}
        onFinish={handleTestFinish}
      />
    );

  if (stage === "result")
    return <Result data={result} student={student} onDashboard={() => setStage("dashboard")} />;

  return null;
}