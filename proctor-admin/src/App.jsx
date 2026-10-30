import { useState, useEffect, useCallback, useRef } from "react";

// ---------- CONFIG ----------
// Backend address. Change it with VITE_API_URL in proctor-admin/.env
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";
const TOKEN_KEY = "proctorAdminToken"; // kept in sessionStorage: it is cleared when the tab is closed
const AUTO_REFRESH_MS = 20000;         // the lists refresh by themselves (live monitoring)
const RISK_FLAGGED = 10;               // a risk score above this is "Flagged"
const OTP_RESEND_SECONDS = 30;         // gap before another OTP can be requested

// Removes everything the old offline mock version stored in this browser
try {
  localStorage.removeItem("proctor_mock_students");
  localStorage.removeItem("proctorOtpAttempts");
  if (sessionStorage.getItem(TOKEN_KEY) === "mock_jwt_token_admin_2026") {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY + ":email");
  }
} catch { /* ignore */ }

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
  EXTRA_DISPLAY: "Extra monitor connected",
  BLOCKED_APP: "Blocked application running",
  TAB_SWITCH: "Switched to another tab or app",
};

// ---------- API ----------
class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.status = status; // 0 = the server could not be reached
    this.code = code;
    this.data = data;
  }
}

// Calls the backend. Throws an ApiError with a readable message on any failure.
async function api(path, { method = "GET", body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
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
    if (e.name === "AbortError") throw new ApiError("The server took too long to respond.", 0);
    throw new ApiError("Could not reach the server at " + API_BASE + ". Is the backend running, and does its CORS list include this address?", 0);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    throw new ApiError(
      (json && (json.error || json.message)) || "Request failed (" + res.status + ") on " + path,
      res.status,
      json && json.code,
      json
    );
  }
  return json;
}

// Images from the backend are data URLs or "/uploads/..." paths; this turns them into usable URLs
const imgUrl = (u) => {
  if (!u) return null;
  if (/^(https?:|data:)/.test(u)) return u;
  return API_BASE + (u.startsWith("/") ? u : "/" + u);
};

// Accepts either a plain array or an object that holds the array
const listOf = (d, key) => (Array.isArray(d) ? d : d && Array.isArray(d[key]) ? d[key] : []);

// ---------- HELPERS ----------
const fmtDate = (v) => (v ? new Date(v).toLocaleString() : "-");
const fmtTime = (v) => (v ? new Date(v).toLocaleTimeString() : "-");
const hasMarks = (a) => !!a && typeof a.score === "number" && typeof a.total === "number";
const marksText = (a) => (hasMarks(a) ? a.score + "/" + a.total : "-");
const sevColor = (s) => (s === "high" ? "text-red-600" : s === "medium" ? "text-amber-600" : "text-slate-400");
const clock = (secs) => Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");

// Status of a student, based on the latest attempt
function studentStatus(s) {
  if (!s.faceRegistered) return "Not registered";
  if (!s.latest) return "Not attempted";
  if ((s.latest.risk || 0) > RISK_FLAGGED) return "Flagged";
  if ((s.latest.eventCount || 0) > 0 || (s.latest.strikes || 0) > 0) return "Review";
  return "Clean";
}
// Status of one test record
function recordStatus(r) {
  if ((r.risk || 0) > RISK_FLAGGED) return "Flagged";
  if ((r.eventCount || 0) > 0 || (r.strikes || 0) > 0) return "Review";
  return "Clean";
}

const STATUS_STYLE = {
  "Not registered": "bg-slate-100 text-slate-600",
  "Not attempted": "bg-blue-100 text-blue-700",
  Clean: "bg-green-100 text-green-700",
  Review: "bg-amber-100 text-amber-700",
  Flagged: "bg-red-100 text-red-700",
};
function StatusBadge({ status }) {
  return <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[status]}`}>{status}</span>;
}

// Downloads a table as a CSV file
function downloadCsv(filename, header, lines) {
  const csv = [header, ...lines].map((l) => l.map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- SHARED STYLES ----------
const primaryBtn =
  "w-full py-3 rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-[0.98] " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-md shadow-blue-600/20";
const ghostBtn =
  "px-4 py-2 rounded-xl text-sm font-medium bg-white border border-slate-300 hover:bg-slate-50 " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition";
const dangerBtn =
  "px-4 py-2 rounded-xl text-sm font-medium bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 " +
  "disabled:opacity-40 disabled:cursor-not-allowed transition";
const fieldBox =
  "w-full px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-900 outline-none transition " +
  "focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10 placeholder:text-slate-400";

// ---------- SMALL COMPONENTS ----------
function Zoom({ src, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!src) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-4 cursor-zoom-out" onClick={onClose}>
      <img src={src} alt="enlarged" className="max-h-[88vh] max-w-full rounded-2xl shadow-2xl" />
    </div>
  );
}

// A photo that shows a placeholder if there is no image or it cannot be loaded
function Photo({ src, className, onClick, empty = "N/A" }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  if (!src || broken) {
    return <div className={`${className} bg-slate-100 text-slate-400 text-xs flex items-center justify-center`}>{empty}</div>;
  }
  return <img src={src} alt="" className={className} onClick={onClick} onError={() => setBroken(true)} />;
}

// Shows whether the backend can be reached, and where its data comes from
function BackendStatus({ health, dark }) {
  let dot = "bg-slate-400";
  let text = "Checking the backend...";
  if (health && health.error) {
    dot = "bg-red-500";
    text = "Cannot reach the backend at " + API_BASE;
  } else if (health) {
    dot = health.db ? "bg-green-500" : "bg-amber-500";
    text =
      "Backend connected · data from " + (health.source === "airtable" ? "Airtable" : "demo data") +
      " · database " + (health.db ? "connected" : "NOT connected");
  }
  return (
    <p className={`flex items-center gap-2 text-xs ${dark ? "text-slate-500" : "text-slate-500"}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {text}
    </p>
  );
}

// ---------- LOGIN (admin email + OTP, both checked by the backend) ----------
function Login({ notice, onLogin }) {
  const [step, setStep] = useState("email"); // email | otp
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [lockedFor, setLockedFor] = useState(0);
  const [health, setHealth] = useState(null);

  // Asks the backend if it is alive (this is what proves the app is connected)
  useEffect(() => {
    let alive = true;
    api("/api/health")
      .then((h) => alive && setHealth(h))
      .catch((e) => alive && setHealth({ error: e.message }));
    return () => { alive = false; };
  }, []);

  const ticking = cooldown > 0 || lockedFor > 0;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1));
      setLockedFor((l) => Math.max(0, l - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const handleError = (e) => {
    if (e.status === 429 && e.data && e.data.retryAfterSeconds) {
      setLockedFor(e.data.retryAfterSeconds);
      setError("");
    } else if (e.data && typeof e.data.attemptsLeft === "number") {
      setError(e.message + " " + e.data.attemptsLeft + " attempts left.");
    } else {
      setError(e.message);
    }
  };

  const sendOtp = async (e) => {
    if (e) e.preventDefault();
    if (busy || cooldown > 0 || lockedFor > 0) return;
    if (!/\S+@\S+\.\S+/.test(email)) return setError("Enter a valid email address");
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/otp/send", { method: "POST", body: { email: email.trim() } });
      setOtp("");
      setStep("otp");
      setCooldown(OTP_RESEND_SECONDS);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    if (busy || lockedFor > 0) return;
    setBusy(true);
    setError("");
    try {
      const d = await api("/api/admin/otp/verify", { method: "POST", body: { email: email.trim(), otp } });
      if (!d || !d.token) throw new ApiError("The server did not return a login token.", 0);
      onLogin(d.token, (d.admin && d.admin.email) || email.trim());
    } catch (err) {
      setOtp("");
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const locked = lockedFor > 0;
  const lockBox = locked && (
    <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
      Too many wrong attempts. This account is locked. Try again in <span className="font-mono font-bold">{clock(lockedFor)}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 via-blue-900 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8">
        <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-xl font-bold mb-5 shadow-lg shadow-blue-600/30">
          SP
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Admin Login</h1>
        <p className="text-slate-500 mt-1 mb-6">
          {step === "email" ? "Enter your admin email to receive a one-time password." : "Enter the OTP sent to your email."}
        </p>

        {notice && <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 mb-4">{notice}</div>}

        {step === "email" ? (
          <form onSubmit={sendOtp} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Admin Email</label>
              <input
                className={fieldBox}
                type="email"
                placeholder="guptapriyanshi522@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </div>
            {lockBox}
            {!locked && error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}
            <button type="submit" className={primaryBtn} disabled={busy || locked}>{busy ? "Sending OTP..." : "Send OTP"}</button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-3.5 text-xs text-blue-900">
              <p className="font-semibold text-blue-950">OTP sent to: <b>{email}</b></p>
              <p className="text-slate-600 mt-1">Please check your email inbox (and Spam folder) for the 6-digit verification code.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Enter OTP</label>
              <input
                className={fieldBox + " font-mono text-center tracking-[0.5em] text-lg"}
                inputMode="numeric"
                maxLength={6}
                placeholder="------"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                disabled={locked}
                autoFocus
              />
            </div>
            {lockBox}
            {!locked && error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}
            <button type="submit" className={primaryBtn} disabled={busy || locked || otp.length !== 6}>
              {busy ? "Verifying..." : "Verify & Sign In"}
            </button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" className="text-slate-500 hover:underline" onClick={() => { setStep("email"); setError(""); }}>
                Change Email
              </button>
              <button
                type="button"
                className="text-blue-600 hover:underline disabled:text-slate-400 disabled:no-underline"
                disabled={cooldown > 0 || busy || locked}
                onClick={() => sendOtp()}
              >
                {cooldown > 0 ? "Resend OTP in " + cooldown + "s" : "Resend OTP"}
              </button>
            </div>
          </form>
        )}

        <div className="mt-6 pt-4 border-t border-slate-100">
          <BackendStatus health={health} />
        </div>
      </div>
    </div>
  );
}

// ---------- STUDENT DETAIL (every test attempt, with violations and snapshots) ----------
function StudentDetail({ token, regNo, onBack, onAuthError, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api("/api/admin/students/" + regNo, { token });
      setData(d);
      setError("");
    } catch (e) {
      if (e.status === 401 || e.status === 403) return onAuthError();
      setError(e.message);
    }
  }, [regNo, token, onAuthError]);

  useEffect(() => { load(); }, [load]);

  const act = async (path, method, confirmText) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api(path, { method, token });
      await load();
      onChanged();
    } catch (e) {
      if (e.status === 401 || e.status === 403) return onAuthError();
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div>
        <button onClick={onBack} className="text-blue-600 font-medium hover:underline mb-4">&larr; Back to all students</button>
        {error ? <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3">{error}</div> : <p className="text-slate-500">Loading...</p>}
      </div>
    );
  }

  const s = data.student || {};
  const attempts = data.attempts || [];
  const latest = attempts[0];
  const status = !s.faceRegistered
    ? "Not registered"
    : !latest
    ? "Not attempted"
    : recordStatus({ risk: latest.risk, strikes: latest.strikes, eventCount: (latest.events || []).length });

  return (
    <div>
      <Zoom src={zoom} onClose={() => setZoom(null)} />
      <button onClick={onBack} className="text-blue-600 font-medium hover:underline mb-4">&larr; Back to all students</button>
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 mb-4">{error}</div>}

      <div className="grid md:grid-cols-[280px_1fr] gap-4 items-start">
        {/* Profile card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <Photo
            src={imgUrl(s.facePhotoUrl)}
            className="w-full aspect-[4/3] object-cover rounded-xl cursor-zoom-in"
            onClick={() => setZoom(imgUrl(s.facePhotoUrl))}
            empty="No face photo"
          />
          <p className="text-xs text-slate-500 mt-2">Registered face (identity reference, saved once)</p>
          <h2 className="text-xl font-bold mt-3">{s.name}</h2>
          <p className="text-sm text-slate-500 font-mono">{s.regNo}</p>
          <p className="text-sm text-slate-500 break-all">{s.email}</p>
          <div className="mt-3"><StatusBadge status={status} /></div>
          <p className="text-xs text-slate-500 mt-3">Face registered: {s.faceRegistered ? fmtDate(s.registeredAt) : "No"}</p>
          <div className="mt-4 space-y-2">
            <button
              disabled={busy || !s.faceRegistered}
              onClick={() => act("/api/admin/students/" + regNo + "/reset-face", "POST", "Remove the registered face of " + regNo + "? The student will have to register again.")}
              className={ghostBtn + " w-full"}
            >
              Reset registered face
            </button>
            <button
              disabled={busy || attempts.length === 0}
              onClick={() => act("/api/admin/students/" + regNo + "/results", "DELETE", "Delete all test records and snapshots of " + regNo + "?")}
              className={dangerBtn + " w-full"}
            >
              Delete all test records
            </button>
          </div>
        </div>

        {/* Attempts */}
        <div className="space-y-4">
          <h3 className="text-lg font-bold text-slate-800">Test attempts ({attempts.length})</h3>
          {attempts.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center text-slate-400">
              This student has not submitted a test yet.
            </div>
          )}
          {attempts.map((a, idx) => {
            const events = a.events || [];
            return (
              <div key={a.id || idx} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <p className="font-bold text-blue-900">{a.testTitle || "Online Assessment"}{idx === 0 ? " (latest)" : ""}</p>
                    <p className="text-xs text-slate-500">{fmtDate(a.submittedAt)}{a.reason ? " · " + a.reason : ""}</p>
                  </div>
                  <div className="flex items-center gap-5 text-sm">
                    <div className="text-center">
                      <p className="text-3xl font-bold text-blue-700 leading-none">{marksText(a)}</p>
                      <p className="text-xs text-slate-500 mt-1">Marks</p>
                    </div>
                    {typeof a.answered === "number" && (
                      <div className="text-center">
                        <p className="text-xl font-semibold leading-none">{a.answered}</p>
                        <p className="text-xs text-slate-500 mt-1">Answered</p>
                      </div>
                    )}
                    <div className="text-center">
                      <p className="text-xl font-semibold leading-none">{a.strikes ?? 0}</p>
                      <p className="text-xs text-slate-500 mt-1">Strikes</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xl font-semibold leading-none">{a.risk ?? 0}</p>
                      <p className="text-xs text-slate-500 mt-1">Risk</p>
                    </div>
                  </div>
                </div>

                <p className="text-sm font-medium text-slate-700 mb-2">Proctoring snapshots and violations ({events.length})</p>
                {events.length === 0 ? (
                  <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg inline-block">No violations detected in this test.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {events.map((e, i) => {
                      const snap = imgUrl(e.snapshotUrl || e.snapshot);
                      return (
                        <div key={i} className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
                          <Photo src={snap} className="w-full aspect-video object-cover cursor-zoom-in" onClick={() => setZoom(snap)} empty="No snapshot" />
                          <div className="p-2">
                            <p className="text-xs font-semibold text-slate-800">{EVENT_LABELS[e.type] || e.type}</p>
                            <p className="text-xs text-slate-500">
                              {e.questionNo ? "Q" + e.questionNo + " · " : ""}{fmtTime(e.timestamp)} ·{" "}
                              <span className={sevColor(e.severity)}>{e.severity}</span>
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- STUDENTS TAB ----------
function StudentsTab({ students, loading, onOpen, onZoom }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("name");

  const rows = students.map((s) => ({ ...s, status: studentStatus(s) }));
  const attempted = rows.filter((r) => r.latest);
  const graded = attempted.filter((r) => hasMarks(r.latest));
  const avg = graded.length
    ? Math.round(graded.reduce((a, r) => a + (r.latest.score / (r.latest.total || 1)) * 100, 0) / graded.length)
    : null;
  const stats = [
    ["Total Students", rows.length],
    ["Face Registered", rows.filter((r) => r.faceRegistered).length],
    ["Students Attempted", attempted.length],
    ["Average Score", avg === null ? "-" : avg + "%"],
    ["Flagged Risk", rows.filter((r) => r.status === "Flagged").length],
  ];

  const q = query.trim().toLowerCase();
  let visible = rows.filter((r) => {
    if (filter !== "All" && r.status !== filter) return false;
    return !q || String(r.regNo).toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q) || (r.email || "").toLowerCase().includes(q);
  });
  const pct = (r) => (hasMarks(r.latest) ? r.latest.score / (r.latest.total || 1) : -1);
  visible = [...visible].sort((a, b) => {
    if (sort === "risk") return (b.latest ? b.latest.risk || 0 : -1) - (a.latest ? a.latest.risk || 0 : -1);
    if (sort === "marks") return pct(b) - pct(a);
    if (sort === "recent") return (b.latest ? new Date(b.latest.submittedAt).getTime() : 0) - (a.latest ? new Date(a.latest.submittedAt).getTime() : 0);
    return (a.name || "").localeCompare(b.name || "");
  });

  const exportCsv = () =>
    downloadCsv(
      "students.csv",
      ["Registration number", "Name", "Email", "Face registered", "Total tests", "Latest marks", "Total", "Violations", "Strikes", "Risk", "Status", "Last submitted"],
      rows.map((r) => [
        r.regNo, r.name, r.email, r.faceRegistered ? "Yes" : "No", r.attemptsCount ?? 0,
        hasMarks(r.latest) ? r.latest.score : "", r.latest ? r.latest.total ?? "" : "",
        r.latest ? r.latest.eventCount ?? "" : "", r.latest ? r.latest.strikes ?? "" : "", r.latest ? r.latest.risk ?? "" : "",
        r.status, r.latest ? fmtDate(r.latest.submittedAt) : "",
      ])
    );

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        {stats.map(([label, value]) => (
          <div key={label} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          className={fieldBox + " !py-2.5 flex-1 min-w-[220px]"}
          placeholder="Search by name, email or reg number"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={ghostBtn} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["All", "Flagged", "Review", "Clean", "Not attempted", "Not registered"].map((o) => <option key={o}>{o}</option>)}
        </select>
        <select className={ghostBtn} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="name">Sort: Name</option>
          <option value="risk">Sort: Risk (High first)</option>
          <option value="marks">Sort: Marks (High first)</option>
          <option value="recent">Sort: Most Recent</option>
        </select>
        <button onClick={exportCsv} className="px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition">Export CSV</button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Student</th>
              <th className="px-4 py-3 font-medium">Total Tests</th>
              <th className="px-4 py-3 font-medium">Latest Marks</th>
              <th className="px-4 py-3 font-medium">Violations</th>
              <th className="px-4 py-3 font-medium">Strikes</th>
              <th className="px-4 py-3 font-medium">Risk</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Loading students...</td></tr>}
            {!loading && visible.map((r) => (
              <tr key={r.regNo} className="border-t border-slate-100 hover:bg-slate-50 transition">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Photo
                      src={imgUrl(r.facePhotoUrl)}
                      className="w-12 h-12 rounded-full object-cover cursor-zoom-in shrink-0"
                      onClick={() => onZoom(imgUrl(r.facePhotoUrl))}
                    />
                    <div>
                      <p className="font-semibold">{r.name}</p>
                      <p className="text-xs text-slate-500 font-mono">{r.regNo}</p>
                      <p className="text-xs text-slate-400">{r.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">{r.attemptsCount ?? 0}</td>
                <td className="px-4 py-3 font-semibold">{r.latest ? marksText(r.latest) : "-"}</td>
                <td className="px-4 py-3">{r.latest ? r.latest.eventCount ?? "-" : "-"}</td>
                <td className="px-4 py-3">{r.latest ? r.latest.strikes ?? "-" : "-"}</td>
                <td className="px-4 py-3">{r.latest ? r.latest.risk ?? "-" : "-"}</td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => onOpen(r.regNo)} className="text-blue-600 font-medium hover:underline">View details</button>
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                  {students.length === 0 ? "No students yet. Add students to the Roll table in Airtable." : "No students match the filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- TEST RECORDS TAB ----------
function RecordsTab({ records, loading, onOpen }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");

  const rows = records.map((r) => ({ ...r, status: recordStatus(r) }));
  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (filter !== "All" && r.status !== filter) return false;
    return !q || String(r.regNo).toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q) || (r.testTitle || "").toLowerCase().includes(q);
  });

  const exportCsv = () =>
    downloadCsv(
      "test-records.csv",
      ["Submitted", "Registration number", "Name", "Email", "Test", "Marks", "Total", "Answered", "Violations", "Strikes", "Risk", "Status", "Reason"],
      rows.map((r) => [fmtDate(r.submittedAt), r.regNo, r.name, r.email, r.testTitle, r.score ?? "", r.total ?? "", r.answered ?? "", r.eventCount ?? 0, r.strikes ?? 0, r.risk ?? 0, r.status, r.reason])
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          className={fieldBox + " !py-2.5 flex-1 min-w-[220px]"}
          placeholder="Search by name, reg number or test"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={ghostBtn} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["All", "Flagged", "Review", "Clean"].map((o) => <option key={o}>{o}</option>)}
        </select>
        <button onClick={exportCsv} className="px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition">Export CSV</button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Submitted</th>
              <th className="px-4 py-3 font-medium">Student</th>
              <th className="px-4 py-3 font-medium">Test</th>
              <th className="px-4 py-3 font-medium">Marks</th>
              <th className="px-4 py-3 font-medium">Answered</th>
              <th className="px-4 py-3 font-medium">Violations</th>
              <th className="px-4 py-3 font-medium">Strikes</th>
              <th className="px-4 py-3 font-medium">Risk</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">Loading test records...</td></tr>}
            {!loading && visible.map((r) => (
              <tr key={r.id || r.regNo + r.submittedAt} className="border-t border-slate-100 hover:bg-slate-50 transition">
                <td className="px-4 py-3 whitespace-nowrap">{fmtDate(r.submittedAt)}</td>
                <td className="px-4 py-3">
                  <p className="font-semibold">{r.name || "-"}</p>
                  <p className="text-xs text-slate-500 font-mono">{r.regNo}</p>
                </td>
                <td className="px-4 py-3">{r.testTitle || "-"}</td>
                <td className="px-4 py-3 font-semibold">{marksText(r)}</td>
                <td className="px-4 py-3">{r.answered ?? "-"}</td>
                <td className="px-4 py-3">{r.eventCount ?? 0}</td>
                <td className="px-4 py-3">{r.strikes ?? 0}</td>
                <td className="px-4 py-3">{r.risk ?? 0}</td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => onOpen(r.regNo)} className="text-blue-600 font-medium hover:underline">View evidence</button>
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                  {records.length === 0 ? "No tests have been submitted yet." : "No records match the filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- DASHBOARD ----------
function Dashboard({ token, adminEmail, onLogout, onAuthError }) {
  const [tab, setTab] = useState("students"); // students | records
  const [students, setStudents] = useState([]);
  const [records, setRecords] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [selected, setSelected] = useState(null);
  const [auto, setAuto] = useState(true);
  const [zoom, setZoom] = useState(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [s, r] = await Promise.all([
        api("/api/admin/students", { token }),
        api("/api/admin/records", { token }),
      ]);
      setStudents(listOf(s, "students"));
      setRecords(listOf(r, "records"));
      setError("");
      setUpdatedAt(Date.now());
      api("/api/health").then(setHealth).catch((e) => setHealth({ error: e.message }));
    } catch (e) {
      if (e.status === 401 || e.status === 403) onAuthError();
      else setError(e.message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [token, onAuthError]);

  useEffect(() => { load(); }, [load]);

  // Live monitoring: refresh the lists every few seconds (not while a student is open)
  useEffect(() => {
    if (!auto || selected) return;
    const id = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, selected, load]);

  const tabBtn = (id, label, count) => (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${tab === id ? "bg-blue-600 text-white shadow" : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50"}`}
    >
      {label} <span className={tab === id ? "text-blue-100" : "text-slate-400"}>({count})</span>
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Zoom src={zoom} onClose={() => setZoom(null)} />

      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-sm">SP</div>
            <div>
              <p className="font-bold leading-tight">Admin Dashboard</p>
              <p className="text-xs text-slate-500">Student records, marks &amp; proctoring snapshots</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:block text-xs text-slate-500">{adminEmail}</span>
            <button onClick={onLogout} className={ghostBtn}>Log out</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {selected ? (
          <StudentDetail
            token={token}
            regNo={selected}
            onBack={() => { setSelected(null); load(); }}
            onAuthError={onAuthError}
            onChanged={load}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex gap-2">
                {tabBtn("students", "Students", students.length)}
                {tabBtn("records", "Test records", records.length)}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input type="checkbox" className="accent-blue-600" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                  Auto-refresh
                </label>
                <button onClick={load} className={ghostBtn}>Refresh</button>
              </div>
            </div>

            {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 mb-4">{error}</div>}

            {tab === "students" ? (
              <StudentsTab students={students} loading={loading} onOpen={setSelected} onZoom={setZoom} />
            ) : (
              <RecordsTab records={records} loading={loading} onOpen={setSelected} />
            )}

            <div className="mt-4 space-y-1">
              <BackendStatus health={health} />
              <p className="text-xs text-slate-400">
                {updatedAt ? "Last updated " + fmtTime(updatedAt) : ""}
                {auto ? " · refreshes every " + AUTO_REFRESH_MS / 1000 + " seconds" : ""}
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ---------- APP ----------
export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [email, setEmail] = useState(() => sessionStorage.getItem(TOKEN_KEY + ":email") || "");
  const [notice, setNotice] = useState("");

  const login = (t, mail) => {
    sessionStorage.setItem(TOKEN_KEY, t);
    sessionStorage.setItem(TOKEN_KEY + ":email", mail);
    setNotice("");
    setToken(t);
    setEmail(mail);
  };
  const logout = useCallback((msg) => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY + ":email");
    setNotice(typeof msg === "string" ? msg : "");
    setToken("");
    setEmail("");
  }, []);
  // Called when the server says the token is invalid or expired
  const authError = useCallback(() => logout("Your session has expired. Please log in again."), [logout]);

  if (!token) return <Login notice={notice} onLogin={login} />;
  return <Dashboard token={token} adminEmail={email} onLogout={() => logout()} onAuthError={authError} />;
}