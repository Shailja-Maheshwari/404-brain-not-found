import { useState, useEffect, useCallback, useRef } from "react";

// ---------- CONFIG & MOCK STORAGE ----------
const TOKEN_KEY = "proctorAdminToken";
const ATTEMPTS_KEY = "proctorOtpAttempts";
const MAX_OTP_ATTEMPTS = 10;
const RISK_FLAGGED = 10;

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

// Mock Initial Data (Multiple Tests & History)
const INITIAL_STUDENTS = [
  {
    regNo: "REG2026001",
    name: "Rahul Sharma",
    email: "rahul@example.com",
    faceRegistered: true,
    registeredAt: Date.now() - 86400000 * 5,
    facePhotoUrl: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=300&q=80",
    attempts: [
      {
        id: "att_101",
        testName: "Data Structures Mid-Term",
        submittedAt: Date.now() - 86400000 * 2,
        score: 42,
        total: 50,
        answered: 25,
        strikes: 0,
        risk: 2,
        eventCount: 1,
        events: [
          {
            type: "WINDOW_BLUR",
            severity: "low",
            timestamp: Date.now() - 86400000 * 2 + 300000,
            questionNo: 5,
            snapshotUrl: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=300&q=80",
          },
        ],
      },
      {
        id: "att_102",
        testName: "Algorithms Quiz 1",
        submittedAt: Date.now() - 86400000 * 4,
        score: 18,
        total: 20,
        answered: 10,
        strikes: 0,
        risk: 0,
        eventCount: 0,
        events: [],
      },
    ],
  },
  {
    regNo: "REG2026002",
    name: "Priyanshi Gupta",
    email: "priyanshi@example.com",
    faceRegistered: true,
    registeredAt: Date.now() - 86400000 * 3,
    facePhotoUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=80",
    attempts: [
      {
        id: "att_201",
        testName: "Data Structures Mid-Term",
        submittedAt: Date.now() - 3600000 * 3,
        score: 31,
        total: 50,
        answered: 22,
        strikes: 3,
        risk: 14,
        eventCount: 4,
        reason: "Auto-terminated due to multiple violations",
        events: [
          {
            type: "FACE_MISMATCH",
            severity: "high",
            timestamp: Date.now() - 3600000 * 3 + 120000,
            questionNo: 8,
            snapshotUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=80",
          },
          {
            type: "MULTIPLE_FACES",
            severity: "high",
            timestamp: Date.now() - 3600000 * 3 + 240000,
            questionNo: 12,
            snapshotUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=80",
          },
        ],
      },
    ],
  },
  {
    regNo: "REG2026003",
    name: "Aman Verma",
    email: "aman@example.com",
    faceRegistered: false,
    registeredAt: null,
    facePhotoUrl: null,
    attempts: [],
  },
];

// Local Storage Helper to mimic persistence
function getStoredStudents() {
  const saved = localStorage.getItem("proctor_mock_students");
  if (!saved) {
    localStorage.setItem("proctor_mock_students", JSON.stringify(INITIAL_STUDENTS));
    return INITIAL_STUDENTS;
  }
  return JSON.parse(saved);
}

function saveStoredStudents(data) {
  localStorage.setItem("proctor_mock_students", JSON.stringify(data));
}

// ---------- HELPERS ----------
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : "-");
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString() : "-");
const hasMarks = (a) => !!a && typeof a.score === "number" && typeof a.total === "number";
const marksText = (a) => (hasMarks(a) ? a.score + "/" + a.total : "-");

function getLatestAttempt(s) {
  if (!s.attempts || s.attempts.length === 0) return null;
  return [...s.attempts].sort((a, b) => b.submittedAt - a.submittedAt)[0];
}

function statusOf(s) {
  if (!s.faceRegistered) return "Not registered";
  const latest = getLatestAttempt(s);
  if (!latest) return "Not attempted";
  const events = typeof latest.eventCount === "number" ? latest.eventCount : 0;
  if ((latest.risk || 0) > RISK_FLAGGED) return "Flagged";
  if (events > 0 || (latest.strikes || 0) > 0) return "Review";
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

const sevColor = (s) => (s === "high" ? "text-red-600" : s === "medium" ? "text-amber-600" : "text-slate-400");

// ---------- STYLES ----------
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

// ---------- LOGIN (EMAIL + OTP WITH 10-ATTEMPT BLOCK) ----------
function Login({ notice, onLogin }) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState(1); // 1: Email, 2: OTP
  const [generatedOtp, setGeneratedOtp] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failCount, setFailCount] = useState(() => Number(localStorage.getItem(ATTEMPTS_KEY) || 0));

  const isBlocked = failCount >= MAX_OTP_ATTEMPTS;

  const fail = (msg, increment = false) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 500);
    if (increment) {
      const updated = failCount + 1;
      setFailCount(updated);
      localStorage.setItem(ATTEMPTS_KEY, updated.toString());
    }
  };

  const handleSendOtp = (e) => {
    e.preventDefault();
    if (isBlocked) return;
    if (!/\S+@\S+\.\S+/.test(email)) return fail("Enter a valid email address");

    setBusy(true);
    setTimeout(() => {
      const mockCode = "123456"; // Default Mock OTP for testing
      setGeneratedOtp(mockCode);
      setStep(2);
      setError("");
      setBusy(false);
    }, 600);
  };

  const handleVerifyOtp = (e) => {
    e.preventDefault();
    if (isBlocked) return;
    if (!otp.trim()) return fail("Please enter the OTP");

    setBusy(true);
    setTimeout(() => {
      if (otp.trim() === generatedOtp || otp.trim() === "123456") {
        localStorage.removeItem(ATTEMPTS_KEY);
        setFailCount(0);
        onLogin("mock_jwt_token_admin_2026", email.trim());
      } else {
        fail(`Invalid OTP. Attempts left: ${MAX_OTP_ATTEMPTS - (failCount + 1)}`, true);
        setOtp("");
      }
      setBusy(false);
    }, 500);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 via-blue-900 to-slate-900 flex items-center justify-center p-4">
      <div className={`w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 anim-fade-up ${shake ? "anim-shake" : ""}`}>
        <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-xl font-bold mb-5 shadow-lg shadow-blue-600/30">
          SP
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Admin Login</h1>
        <p className="text-slate-500 mt-1 mb-6">Enter your email to receive an OTP for portal access.</p>

        {notice && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 mb-4">{notice}</div>
        )}

        {isBlocked ? (
          <div className="rounded-xl bg-red-100 border border-red-300 text-red-800 p-4 text-center">
            <p className="font-bold">Account Locked!</p>
            <p className="text-xs mt-1">You have exceeded 10 failed OTP attempts. Please contact administrator support.</p>
          </div>
        ) : (
          <>
            {step === 1 ? (
              <form onSubmit={handleSendOtp} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Admin Email</label>
                  <input
                    className={fieldBox}
                    type="email"
                    placeholder="admin@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                  />
                </div>
                {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}
                <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Sending OTP..." : "Get OTP"}</button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 text-xs text-blue-800">
                  Demo OTP sent to <b>{email}</b>. Use code: <b className="font-mono text-sm underline">123456</b>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Enter OTP</label>
                  <input
                    className={fieldBox + " font-mono text-center tracking-widest text-lg"}
                    type="text"
                    maxLength={6}
                    placeholder="123456"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    autoFocus
                  />
                </div>
                {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}
                <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Verifying..." : "Verify & Sign In"}</button>
                <button
                  type="button"
                  onClick={() => { setStep(1); setError(""); }}
                  className="w-full text-center text-xs text-slate-500 hover:underline mt-2"
                >
                  Change Email
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- IMAGE ZOOM ----------
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

function Photo({ src, className, onClick, empty = "No photo" }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  if (!src || broken) {
    return <div className={`${className} bg-slate-100 text-slate-400 text-xs flex items-center justify-center`}>{empty}</div>;
  }
  return <img src={src} alt="" className={className} onClick={onClick} onError={() => setBroken(true)} />;
}

// ---------- STUDENT DETAIL (WITH ALL TEST RECORDS HISTORY) ----------
function StudentDetail({ regNo, onBack, onChanged }) {
  const [students, setStudents] = useState(getStoredStudents);
  const [zoom, setZoom] = useState(null);

  const student = students.find((s) => s.regNo === regNo);

  const resetFace = () => {
    if (!window.confirm("Remove the registered face of " + regNo + "?")) return;
    const updated = students.map((s) => s.regNo === regNo ? { ...s, faceRegistered: false, facePhotoUrl: null } : s);
    saveStoredStudents(updated);
    setStudents(updated);
    onChanged();
  };

  const deleteResults = () => {
    if (!window.confirm("Delete all test records and snapshots for " + regNo + "?")) return;
    const updated = students.map((s) => s.regNo === regNo ? { ...s, attempts: [] } : s);
    saveStoredStudents(updated);
    setStudents(updated);
    onChanged();
  };

  if (!student) {
    return (
      <div>
        <button onClick={onBack} className="text-blue-600 font-medium hover:underline mb-4">&larr; Back to all students</button>
        <p className="text-slate-500">Student not found.</p>
      </div>
    );
  }

  const attempts = student.attempts || [];
  const status = statusOf(student);

  return (
    <div>
      <Zoom src={zoom} onClose={() => setZoom(null)} />
      <button onClick={onBack} className="text-blue-600 font-medium hover:underline mb-4">&larr; Back to all students</button>

      <div className="grid md:grid-cols-[280px_1fr] gap-4 items-start">
        {/* Profile Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <Photo
            src={student.facePhotoUrl}
            className="w-full aspect-[4/3] object-cover rounded-xl cursor-zoom-in"
            onClick={() => setZoom(student.facePhotoUrl)}
            empty="No face photo"
          />
          <p className="text-xs text-slate-500 mt-2">Registered face (identity reference)</p>
          <h2 className="text-xl font-bold mt-3">{student.name}</h2>
          <p className="text-sm text-slate-500 font-mono">{student.regNo}</p>
          <p className="text-sm text-slate-500 break-all">{student.email}</p>
          <div className="mt-3"><StatusBadge status={status} /></div>
          <p className="text-xs text-slate-500 mt-3">
            Face registered: {student.faceRegistered ? fmtDate(student.registeredAt) : "No"}
          </p>
          <div className="mt-4 space-y-2">
            <button disabled={!student.faceRegistered} onClick={resetFace} className={ghostBtn + " w-full"}>
              Reset registered face
            </button>
            <button disabled={attempts.length === 0} onClick={deleteResults} className={dangerBtn + " w-full"}>
              Delete all test records
            </button>
          </div>
        </div>

        {/* All Test Attempt Records */}
        <div className="space-y-4">
          <h3 className="text-lg font-bold text-slate-800">Test Attempts History ({attempts.length})</h3>
          {attempts.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center text-slate-400">
              This student has not submitted any test records yet.
            </div>
          )}
          {attempts.map((a, idx) => {
            const events = a.events || [];
            return (
              <div key={a.id || idx} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <p className="font-bold text-blue-900">{a.testName || "Online Assessment"}</p>
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

                <p className="text-sm font-medium text-slate-700 mb-2">Proctoring Snapshots & Violations ({events.length})</p>
                {events.length === 0 ? (
                  <p className="text-green-600 text-xs bg-green-50 p-2 rounded-lg inline-block">No violations detected in this test.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {events.map((e, i) => (
                      <div key={i} className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
                        <Photo
                          src={e.snapshotUrl}
                          className="w-full aspect-video object-cover cursor-zoom-in"
                          onClick={() => setZoom(e.snapshotUrl)}
                          empty="No snapshot"
                        />
                        <div className="p-2">
                          <p className="text-xs font-semibold text-slate-800">{EVENT_LABELS[e.type] || e.type}</p>
                          <p className="text-xs text-slate-500">
                            {e.questionNo ? "Q" + e.questionNo + " · " : ""}{fmtTime(e.timestamp)} ·{" "}
                            <span className={sevColor(e.severity)}>{e.severity}</span>
                          </p>
                        </div>
                      </div>
                    ))}
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

// ---------- MAIN DASHBOARD ----------
function Dashboard({ adminEmail, onLogout }) {
  const [students, setStudents] = useState(getStoredStudents);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("name");
  const [zoom, setZoom] = useState(null);

  const refreshData = () => {
    setStudents(getStoredStudents());
  };

  const rows = students.map((s) => {
    const latest = getLatestAttempt(s);
    return { ...s, latest, status: statusOf(s) };
  });

  const attempted = rows.filter((r) => r.latest);
  const graded = attempted.filter((r) => hasMarks(r.latest));
  const avg = graded.length
    ? Math.round(graded.reduce((a, r) => a + (r.latest.score / (r.latest.total || 1)) * 100, 0) / graded.length)
    : null;

  const stats = [
    ["Total Students", rows.length],
    ["Face Registered", rows.filter((r) => r.faceRegistered).length],
    ["Attempted Tests", attempted.length],
    ["Average Score", avg === null ? "-" : avg + "%"],
    ["Flagged Risk", rows.filter((r) => r.status === "Flagged").length],
  ];

  const q = query.trim().toLowerCase();
  let visible = rows.filter((r) => {
    if (filter !== "All" && r.status !== filter) return false;
    return !q || r.regNo.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q) || (r.email || "").toLowerCase().includes(q);
  });

  const pct = (r) => (hasMarks(r.latest) ? r.latest.score / (r.latest.total || 1) : -1);
  visible = [...visible].sort((a, b) => {
    if (sort === "risk") return (b.latest ? b.latest.risk || 0 : -1) - (a.latest ? a.latest.risk || 0 : -1);
    if (sort === "marks") return pct(b) - pct(a);
    if (sort === "recent") return (b.latest ? b.latest.submittedAt || 0 : 0) - (a.latest ? a.latest.submittedAt || 0 : 0);
    return (a.name || "").localeCompare(b.name || "");
  });

  const exportCsv = () => {
    const header = ["Registration number", "Name", "Email", "Face registered", "Total Attempts", "Latest Score", "Total Marks", "Strikes", "Risk Score", "Status"];
    const lines = rows.map((r) => [
      r.regNo, r.name, r.email, r.faceRegistered ? "Yes" : "No", r.attempts ? r.attempts.length : 0,
      hasMarks(r.latest) ? r.latest.score : "", r.latest ? r.latest.total ?? "" : "",
      r.latest ? r.latest.strikes ?? "" : "", r.latest ? r.latest.risk ?? "" : "", r.status,
    ]);
    const csv = [header, ...lines].map((l) => l.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "admin-proctoring-records.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Zoom src={zoom} onClose={() => setZoom(null)} />

      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-sm">SP</div>
            <div>
              <p className="font-bold leading-tight">Admin Dashboard (Offline Mock)</p>
              <p className="text-xs text-slate-500">Student records, marks & proctoring snapshots</p>
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
            regNo={selected}
            onBack={() => { setSelected(null); refreshData(); }}
            onChanged={refreshData}
          />
        ) : (
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
              <button onClick={exportCsv} className="px-4 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition">
                Export CSV
              </button>
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
                  {visible.map((r) => (
                    <tr key={r.regNo} className="border-t border-slate-100 hover:bg-slate-50 transition">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Photo
                            src={r.facePhotoUrl}
                            className="w-10 h-10 rounded-full object-cover cursor-zoom-in shrink-0"
                            onClick={() => setZoom(r.facePhotoUrl)}
                            empty="N/A"
                          />
                          <div>
                            <p className="font-semibold">{r.name}</p>
                            <p className="text-xs text-slate-500 font-mono">{r.regNo}</p>
                            <p className="text-xs text-slate-400">{r.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">{r.attempts ? r.attempts.length : 0}</td>
                      <td className="px-4 py-3 font-semibold">{r.latest ? marksText(r.latest) : "-"}</td>
                      <td className="px-4 py-3">{r.latest ? r.latest.eventCount ?? "-" : "-"}</td>
                      <td className="px-4 py-3">{r.latest ? r.latest.strikes ?? "-" : "-"}</td>
                      <td className="px-4 py-3">{r.latest ? r.latest.risk ?? "-" : "-"}</td>
                      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button onClick={() => setSelected(r.regNo)} className="text-blue-600 font-medium hover:underline">
                          View details
                        </button>
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No students found matching filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ---------- MAIN ROOT APP ----------
export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [email, setEmail] = useState(() => sessionStorage.getItem(TOKEN_KEY + ":email") || "");

  const login = (t, mail) => {
    sessionStorage.setItem(TOKEN_KEY, t);
    sessionStorage.setItem(TOKEN_KEY + ":email", mail);
    setToken(t);
    setEmail(mail);
  };

  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY + ":email");
    setToken("");
    setEmail("");
  };

  if (!token) return <Login onLogin={login} />;
  return <Dashboard adminEmail={email} onLogout={logout} />;
}