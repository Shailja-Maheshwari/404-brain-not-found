import { useEffect, useRef, useState } from 'react';
import './ProctorPanel.css';

const MAX_SHOWN = 100;

// Events that belong in the "AI & search activity" card (PDF objective 6)
const AI_TYPES = new Set([
  'AI_SITE_ACTIVE',
  'AI_SITE_LEFT',
  'AI_APP_ACTIVE',
  'AI_APP_RUNNING',
  'WEB_SEARCH_DETECTED',
  'UNSUPPORTED_BROWSER_ACTIVE',
]);

function eventKey(e) {
  return `${e.timestamp}|${e.eventType}|${e.message}`;
}

function mergeEvents(previous, incoming) {
  const map = new Map(previous.map((e) => [eventKey(e), e]));
  incoming.forEach((e) => map.set(eventKey(e), e));
  return [...map.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_SHOWN);
}

function formatDetails(details) {
  return Object.entries(details || {})
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('  ·  ');
}

function EventList({ items, empty }) {
  if (items.length === 0) return <p className="pp-muted">{empty}</p>;
  return (
    <ul className="pp-events">
      {items.map((e) => (
        <li key={eventKey(e)} className={`pp-event pp-${e.severity}`}>
          <div>
            <strong>{e.eventType}</strong>
            <span className="pp-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
          </div>
          <div>{e.message}</div>
          {formatDetails(e.details) && <div className="pp-details">{formatDetails(e.details)}</div>}
        </li>
      ))}
    </ul>
  );
}

export default function ProctorPanel() {
  const proctor = window.proctor; // only exists inside the Electron app (preload bridge)
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState(null);
  const [violations, setViolations] = useState({ count: 0, max: 0, limitReached: false });
  const [warning, setWarning] = useState('');
  const counters = useRef({ keystrokes: 0, clicks: 0, mouseMoves: 0 });

  // Receive events from the Electron main process
  useEffect(() => {
    if (!proctor) return undefined;

    const offEvent = proctor.onEvent((e) => setEvents((prev) => mergeEvents(prev, [e])));
    const offViolation = proctor.onViolation((v) => {
      setViolations(v);
      setWarning(
        v.limitReached
          ? 'Violation limit reached. The test component should auto-submit here (not built yet).'
          : `Warning ${v.count} of ${v.max}: ${v.message}`
      );
    });

    proctor.getHistory().then((h) => setEvents((prev) => mergeEvents(prev, h))).catch(() => {});
    proctor.getStatus().then((s) => {
      setStatus(s);
      setViolations({ count: s.violationCount, max: s.maxViolations, limitReached: s.limitReached });
    }).catch(() => {});

    return () => {
      offEvent();
      offViolation();
    };
  }, [proctor]);

  // Block copy/cut/paste/right-click inside the exam page and count input activity
  useEffect(() => {
    if (!proctor) return undefined;

    const block = (type) => (e) => {
      e.preventDefault();
      proctor.reportActivity(type, {});
    };
    const onCopy = block('CLIPBOARD_COPY_BLOCKED');
    const onCut = block('CLIPBOARD_CUT_BLOCKED');
    const onPaste = block('CLIPBOARD_PASTE_BLOCKED');
    const onMenu = block('CONTEXT_MENU_BLOCKED');
    const onKey = () => { counters.current.keystrokes += 1; };
    const onClick = () => { counters.current.clicks += 1; };
    const onMove = () => { counters.current.mouseMoves += 1; };

    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    document.addEventListener('contextmenu', onMenu);
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    document.addEventListener('mousemove', onMove);

    const timer = setInterval(() => {
      const c = counters.current;
      if (c.keystrokes || c.clicks || c.mouseMoves) {
        proctor.reportActivity('INPUT_ACTIVITY_SUMMARY', { ...c });
        counters.current = { keystrokes: 0, clicks: 0, mouseMoves: 0 };
      }
    }, 10000);

    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('contextmenu', onMenu);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onMove);
      clearInterval(timer);
    };
  }, [proctor]);

  if (!proctor) {
    return (
      <div className="pp-root">
        <h1>Smart Proctor</h1>
        <p>
          The Electron bridge (<code>window.proctor</code>) was not found. Open this page inside the
          Electron app (<code>npm start</code>), not in a normal browser. If you are already in
          Electron, check the log for <code>PRELOAD_ERROR</code>.
        </p>
      </div>
    );
  }

  const aiEvents = events.filter((e) => AI_TYPES.has(e.eventType));

  return (
    <div className="pp-root">
      <header className="pp-header">
        <h1>Smart Proctor</h1>
        <div className="pp-badges">
          <span className="pp-badge">{status?.examMode ? 'EXAM MODE' : 'DEV MODE'}</span>
          <span className={`pp-badge ${violations.count ? 'pp-bad' : ''}`}>
            Violations: {violations.count} / {violations.max}
          </span>
          {status?.devQuit && (
            <button className="pp-quit" onClick={() => proctor.quitDev()}>Quit app (dev only)</button>
          )}
        </div>
      </header>

      {warning && (
        <div className={`pp-warning ${violations.limitReached ? 'pp-limit' : ''}`}>{warning}</div>
      )}

      <section className="pp-card">
        <h2>Question area (placeholder for the MCQ component)</h2>
        <p>Try pasting into the box below. It should be blocked and logged.</p>
        <p className="pp-muted">Violation limit ({violations.max}) is a placeholder. The PDF says repeated violations but gives no number.</p>
        <textarea rows="3" placeholder="Type or try to paste here..." disabled={violations.limitReached} />
      </section>

      <section className="pp-card">
        <h2>AI &amp; search activity (ChatGPT, Claude, searches)</h2>
        <p className="pp-muted">
          Tab switching is allowed. Only the foreground tab of Chrome, Brave, Edge, Vivaldi, Chromium
          and Safari is read. Typed prompts are not captured; &quot;chatTitle&quot; is only a hint.
        </p>
        <EventList items={aiEvents} empty="No AI or search activity detected yet." />
      </section>

      <section className="pp-card">
        <h2>Live activity log (proctor view)</h2>
        {status?.logFile && <p className="pp-muted">Saved to: {status.logFile}</p>}
        <EventList items={events} empty="No events yet." />
      </section>
    </div>
  );
}
