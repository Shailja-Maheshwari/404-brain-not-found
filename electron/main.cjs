const { app, BrowserWindow, screen, ipcMain, globalShortcut, Notification } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ============================================================
// SETTINGS
// ============================================================
// Where the React page runs. We try each address until one answers.
const DEV_URL_CANDIDATES = process.env.START_URL
  ? [process.env.START_URL]
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'];

const EXAM_MODE = process.env.EXAM_MODE === 'true';            // fullscreen + blocked shortcuts
const KIOSK_MODE = false; // Permanently off: the PDF allows tab switching and kiosk mode blocks Cmd+Tab.
const CONTENT_PROTECTION = process.env.CONTENT_PROTECTION === 'true'; // OPTIONAL, unverified on Monterey

// White-screen workaround for old Macs: NO_GPU=true npm start
if (process.env.NO_GPU === 'true') app.disableHardwareAcceleration();

// NOT SPECIFIED IN THE PDF: how many violations count as "repeated". Team decision needed.
// PLACEHOLDER value. Override for testing: MAX_VIOLATIONS=2 npm start
const MAX_VIOLATIONS = Number(process.env.MAX_VIOLATIONS) > 0 ? Number(process.env.MAX_VIOLATIONS) : 5;

// Events that count toward the violation limit. Edit to change the rules.
const COUNTED_EVENTS = new Set([
  'EXTRA_DISPLAY_DETECTED',
  'SCREEN_MIRRORING_DETECTED',
  'BLOCKED_APP_DETECTED',
  'SECOND_INSTANCE_BLOCKED',
]);

// Shown as flags but NOT counted: the PDF allows tab switching but wants AI use tracked and shown.
const FLAG_EVENTS = new Set([
  'AI_SITE_ACTIVE',
  'AI_SITE_LEFT',
  'AI_APP_ACTIVE',
  'AI_APP_RUNNING',
  'WEB_SEARCH_DETECTED',
  'UNSUPPORTED_BROWSER_ACTIVE',
  'EXTERNAL_DEVICE_CONNECTED',
]);

const AI_SITES = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'claude.ai', 'gemini.google.com',
  'copilot.microsoft.com', 'perplexity.ai', 'deepseek.com', 'poe.com', 'grok.com',
];

// Search engine host -> URL parameter holding the query
const SEARCH_ENGINES = [
  { test: (h) => /(^|\.)google\.[a-z.]+$/.test(h), param: 'q' },
  { test: (h) => h.endsWith('bing.com'), param: 'q' },
  { test: (h) => h.endsWith('duckduckgo.com'), param: 'q' },
  { test: (h) => h.endsWith('search.yahoo.com'), param: 'p' },
  { test: (h) => h.endsWith('youtube.com'), param: 'search_query' },
];

// Browsers whose front tab can be read with AppleScript (macOS)
const BROWSERS = {
  'Google Chrome': 'chromium',
  'Brave Browser': 'chromium',
  'Microsoft Edge': 'chromium',
  Vivaldi: 'chromium',
  Chromium: 'chromium',
  Safari: 'safari',
};

// Browsers we CANNOT read. We only log that they are in front.
const UNSUPPORTED_BROWSERS = ['Firefox', 'Arc', 'Opera', 'Tor Browser', 'DuckDuckGo'];

// Names under which our own app can appear as the frontmost app
const OWN_NAMES = new Set(['electron', 'smart proctor', 'smart-proctor']);

// Desktop apps to look for. macOS matches the app path, Windows matches the exe name.
const WATCHED_APPS = [
  { label: 'ChatGPT desktop app', eventType: 'AI_APP_RUNNING', match: ['/chatgpt.app/', '"chatgpt.exe"'] },
  { label: 'Claude desktop app', eventType: 'AI_APP_RUNNING', match: ['/claude.app/', '"claude.exe"'] },
  { label: 'TeamViewer', eventType: 'BLOCKED_APP_DETECTED', match: ['/teamviewer.app/', '"teamviewer.exe"'] },
  { label: 'AnyDesk', eventType: 'BLOCKED_APP_DETECTED', match: ['/anydesk.app/', '"anydesk.exe"'] },
  { label: 'Zoom', eventType: 'BLOCKED_APP_DETECTED', match: ['/zoom.us.app/', '"zoom.exe"'] },
  { label: 'OBS (recording/streaming)', eventType: 'BLOCKED_APP_DETECTED', match: ['/obs.app/', '"obs64.exe"'] },
  { label: 'Discord', eventType: 'BLOCKED_APP_DETECTED', match: ['/discord.app/', '"discord.exe"'] },
];

const ACTIVE_WINDOW_INTERVAL_MS = 2000;
const PROCESS_INTERVAL_MS = 5000;
const HARDWARE_INTERVAL_MS = 15000;

// Only these events may be reported by the web page (renderer).
const RENDERER_EVENTS = {
  CLIPBOARD_COPY_BLOCKED: 'Copy attempt blocked',
  CLIPBOARD_CUT_BLOCKED: 'Cut attempt blocked',
  CLIPBOARD_PASTE_BLOCKED: 'Paste attempt blocked',
  CONTEXT_MENU_BLOCKED: 'Right-click menu blocked',
  INPUT_ACTIVITY_SUMMARY: 'Input activity in the last 10 seconds (counts only)',
};

// ============================================================
// STATE + LOGGING
// ============================================================
let mainWindow = null;
let startUrl = DEV_URL_CANDIDATES[0];
let violationCount = 0;
let limitLogged = false;
let blurredAt = null;
const history = [];
const reportedOnce = new Set();

function getLogFile() {
  return path.join(app.getPath('userData'), 'activity-log.jsonl');
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function logEvent(eventType, message, details = {}) {
  const severity = COUNTED_EVENTS.has(eventType)
    ? 'violation'
    : FLAG_EVENTS.has(eventType)
      ? 'flag'
      : 'info';
  const entry = { eventType, severity, message, details, timestamp: new Date().toISOString() };
  const line = JSON.stringify(entry);

  console.log(line);
  fs.appendFile(getLogFile(), line + '\n', () => {});
  history.push(entry);
  if (history.length > 500) history.shift();
  sendToWindow('proctor:event', entry);

  if (severity === 'violation') {
    violationCount += 1;
    const limitReached = violationCount >= MAX_VIOLATIONS;
    sendToWindow('proctor:violation', { count: violationCount, max: MAX_VIOLATIONS, message, limitReached });
    notifyStudent(limitReached ? 'Test will be auto-submitted' : 'Warning ' + violationCount + ' of ' + MAX_VIOLATIONS, message);
    if (limitReached && !limitLogged) {
      limitLogged = true;
      // The test/timer component must listen for this and auto-submit (not built yet).
      logEvent('VIOLATION_LIMIT_REACHED', `Violation limit (${MAX_VIOLATIONS}) reached`);
    }
  }
}

// Warnings must reach the student even while another app is in front. Best effort.
function notifyStudent(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (error) {
    // notifications are optional
  }
}

function logOnce(key, eventType, message, details) {
  if (reportedOnce.has(key)) return;
  reportedOnce.add(key);
  logEvent(eventType, message, details);
}

function runCommand(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        out: (stdout || '').trim(),
        error: error ? (stderr || error.message).trim() : '',
      });
    });
  });
}

// ============================================================
// CHECK 1: ACTIVE APP + BROWSER TAB (macOS only)
// ============================================================
function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function isAiHost(host) {
  return AI_SITES.some((d) => matchesDomain(host, d));
}

// Returns the search text found in the URL. Chat URLs usually contain NO prompt.
function getQuery(url, host) {
  try {
    const params = new URL(url).searchParams;
    const engine = SEARCH_ENGINES.find((e) => e.test(host));
    if (engine) return params.get(engine.param) || '';
    if (isAiHost(host)) return params.get('q') || params.get('prompt') || params.get('query') || '';
  } catch {
    // ignore bad URLs
  }
  return '';
}

const FRONT_SCRIPT =
  'tell application "System Events"\n' +
  'set p to first application process whose frontmost is true\n' +
  'return (name of p) & "|||" & (unix id of p)\n' +
  'end tell';

let lastActiveKey = '';
let checkingActive = false;
let aiSession = null; // { host, since }

function endAiSession() {
  if (!aiSession) return;
  const seconds = Math.round((Date.now() - aiSession.since) / 1000);
  logEvent('AI_SITE_LEFT', `Left AI site ${aiSession.host} after ${seconds}s`, { host: aiSession.host, seconds });
  aiSession = null;
}

async function checkActiveWindow() {
  if (process.platform !== 'darwin' || checkingActive) return;
  checkingActive = true;
  try {
    const front = await runCommand('osascript', ['-e', FRONT_SCRIPT]);
    if (!front.ok) {
      if (/-1743|not authorized/i.test(front.error)) {
        logOnce('perm-system-events', 'ACTIVE_APP_UNAVAILABLE',
          'Allow Electron to control System Events: System Preferences > Security & Privacy > Privacy > Automation');
      }
      return;
    }

    const sep = front.out.indexOf('|||');
    const appName = sep >= 0 ? front.out.slice(0, sep) : front.out;
    const pid = sep >= 0 ? Number(front.out.slice(sep + 3)) : NaN;

    // Our own app in front: not an external app. Reset so returning to the same tab is logged again.
    const lower = appName.toLowerCase();
    if (pid === process.pid || OWN_NAMES.has(lower) || lower === app.getName().toLowerCase()) {
      lastActiveKey = '';
      endAiSession();
      return;
    }

    let url = '';
    let title = '';
    const kind = BROWSERS[appName];

    if (kind) {
      const script = kind === 'safari'
        ? 'tell application "Safari" to return (URL of current tab of front window) & "|||" & (name of current tab of front window)'
        : `tell application "${appName}" to return (URL of active tab of front window) & "|||" & (title of active tab of front window)`;
      const tab = await runCommand('osascript', ['-e', script]);
      if (tab.ok) {
        const i = tab.out.indexOf('|||');
        url = i >= 0 ? tab.out.slice(0, i) : tab.out;
        title = i >= 0 ? tab.out.slice(i + 3) : '';
      } else if (/-1743|not authorized/i.test(tab.error)) {
        logOnce('perm-' + appName, 'ACTIVE_TAB_UNAVAILABLE',
          `Allow Electron to control ${appName}: System Preferences > Security & Privacy > Privacy > Automation`);
      }
    }

    const key = `${appName}|${url}|${title}`;
    if (key === lastActiveKey) return;
    lastActiveKey = key;

    const host = url ? getHost(url) : '';
    if (aiSession && (!host || aiSession.host !== host)) endAiSession();

    if (!url) {
      logEvent('ACTIVE_APP_CHANGED', `Active app: ${appName}`, { app: appName });
      if (/^(chatgpt|claude)$/i.test(appName)) {
        logEvent('AI_APP_ACTIVE', `${appName} desktop app is in the foreground`, { app: appName });
      }
      if (UNSUPPORTED_BROWSERS.some((b) => lower.includes(b.toLowerCase()))) {
        logEvent('UNSUPPORTED_BROWSER_ACTIVE',
          `${appName} is in front. Its tabs cannot be read, so ChatGPT/Claude use there is NOT tracked`,
          { app: appName });
      }
      return;
    }

    const query = getQuery(url, host);
    if (isAiHost(host)) {
      if (!aiSession) aiSession = { host, since: Date.now() };
      // "prompt" is only filled when the URL carries it. "chatTitle" is the tab title,
      // which AI sites often derive from the first message. It is a hint, NOT the typed text.
      logEvent('AI_SITE_ACTIVE', `AI site in foreground tab: ${host}`, {
        app: appName, host, chatTitle: title, url, prompt: query || 'not available (not in URL)',
      });
    } else if (query) {
      logEvent('WEB_SEARCH_DETECTED', `Search on ${host}: ${query}`, { app: appName, host, query, title });
    } else {
      logEvent('ACTIVE_TAB_CHANGED', `${appName}: ${host}`, { app: appName, host, title });
    }
  } finally {
    checkingActive = false;
  }
}

// ============================================================
// CHECK 2: RUNNING PROCESSES
// ============================================================
const foundApps = new Set();

async function checkProcesses() {
  const result = process.platform === 'win32'
    ? await runCommand('tasklist', ['/fo', 'csv', '/nh'])
    : await runCommand('ps', ['-axo', 'comm=']);
  if (!result.ok) return;

  const text = result.out.toLowerCase();
  for (const item of WATCHED_APPS) {
    const running = item.match.some((m) => text.includes(m));
    if (running && !foundApps.has(item.label)) {
      foundApps.add(item.label);
      logEvent(item.eventType, `${item.label} is running`, { app: item.label });
    } else if (!running && foundApps.has(item.label)) {
      foundApps.delete(item.label);
      logEvent('WATCHED_APP_CLOSED', `${item.label} was closed`, { app: item.label });
    }
  }
}

// ============================================================
// CHECK 3: DISPLAYS + MIRRORING
// ============================================================
let lastDisplayCount = null;
let mirroringActive = false;
let profileLogged = false;

function checkDisplays() {
  const count = screen.getAllDisplays().length;
  if (count === lastDisplayCount) return;
  const before = lastDisplayCount;
  lastDisplayCount = count;

  if (count > 1) {
    logEvent('EXTRA_DISPLAY_DETECTED', `${count} displays connected`, { displayCount: count });
  } else if (before === null) {
    logEvent('DISPLAY_CHECK', 'Single display detected', { displayCount: count });
  } else {
    logEvent('EXTRA_DISPLAY_REMOVED', 'Back to a single display', { displayCount: count });
  }
}

// Electron reports mirrored screens as ONE display, so we also ask macOS directly.
async function checkMirroring() {
  if (process.platform !== 'darwin') return; // Windows: not implemented
  const result = await runCommand('system_profiler', ['SPDisplaysDataType', '-json'], 20000);
  if (!result.ok) return;

  let physical = 0;
  let flagged = false;
  try {
    const data = JSON.parse(result.out);
    for (const gpu of data.SPDisplaysDataType || []) {
      for (const d of gpu.spdisplays_ndrvs || []) {
        physical += 1;
        if (d.spdisplays_mirror === 'spdisplays_on') flagged = true;
      }
    }
  } catch {
    flagged = /"spdisplays_mirror"\s*:\s*"spdisplays_on"/.test(result.out);
  }

  const logical = screen.getAllDisplays().length;
  const mirrored = flagged || (physical > 1 && logical === 1);

  if (!profileLogged) {
    profileLogged = true;
    // Shows what this Mac reports, so the mirroring logic can be checked against real data.
    logEvent('DISPLAY_PROFILE', `macOS reports ${physical} physical display(s)`, {
      physicalDisplays: physical, logicalDisplays: logical, mirrorFlag: flagged,
    });
  }

  if (mirrored && !mirroringActive) {
    mirroringActive = true;
    logEvent('SCREEN_MIRRORING_DETECTED', 'Display mirroring appears to be on', {
      physicalDisplays: physical, logicalDisplays: logical, mirrorFlag: flagged,
    });
  } else if (!mirrored && mirroringActive) {
    mirroringActive = false;
    logEvent('SCREEN_MIRRORING_ENDED', 'Display mirroring appears to be off');
  }
}

// ============================================================
// CHECK 4: USB DEVICES (macOS, best effort)
// ============================================================
let usbBaseline = null;

function collectUsb(nodes, out) {
  for (const n of nodes || []) {
    if (n._name) out.push(`${n._name}#${n.location_id || n.serial_num || ''}`);
    if (n._items) collectUsb(n._items, out);
  }
  return out;
}

async function checkUsb() {
  if (process.platform !== 'darwin') return;
  const result = await runCommand('system_profiler', ['SPUSBDataType', '-json'], 20000);
  if (!result.ok) return;
  let current;
  try {
    current = new Set(collectUsb(JSON.parse(result.out).SPUSBDataType, []));
  } catch {
    return;
  }
  if (!usbBaseline) {
    usbBaseline = current;
    logEvent('USB_BASELINE', `${current.size} USB entries present at start (treated as normal)`, { count: current.size });
    return;
  }
  const added = [...current].filter((d) => !usbBaseline.has(d));
  const removed = [...usbBaseline].filter((d) => !current.has(d));
  added.forEach((d) => {
    usbBaseline.add(d);
    logEvent('EXTERNAL_DEVICE_CONNECTED', `New USB device: ${d.split('#')[0]}`, { device: d });
  });
  removed.forEach((d) => {
    usbBaseline.delete(d);
    logEvent('EXTERNAL_DEVICE_REMOVED', `USB device removed: ${d.split('#')[0]}`, { device: d });
  });
}

// ============================================================
// WINDOW + PAGE LOADING
// ============================================================
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function findStartUrl() {
  for (const url of DEV_URL_CANDIDATES) {
    if (await probe(url)) return url;
  }
  return null;
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let retryTimer = null;
let errorShown = false;

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    loadApp();
  }, 3000);
}

function showLoadError(detail) {
  if (errorShown || !mainWindow || mainWindow.isDestroyed()) return;
  errorShown = true;
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;max-width:720px">
    <h2>Smart Proctor cannot load the exam page yet</h2>
    <p>${esc(detail)}</p>
    <p>Start the page server in another terminal:<br><code>cd /Users/mck/smart-proctor &amp;&amp; npm run dev</code></p>
    <p>This window retries every 3 seconds. To quit: Cmd+Q (or Ctrl+Alt+Shift+X in dev).</p></body>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
}

async function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = await findStartUrl();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!url) {
    logOnce('no-dev-server', 'PAGE_LOAD_FAILED', 'Vite dev server not reachable. Is "npm run dev" running?', {
      tried: DEV_URL_CANDIDATES,
    });
    showLoadError('The Vite dev server did not answer on: ' + DEV_URL_CANDIDATES.join(', '));
    scheduleRetry();
    return;
  }
  startUrl = url;
  mainWindow.loadURL(url).catch(() => {}); // failures are handled by did-fail-load
}

function isAppUrl(u) {
  try {
    return new URL(u).origin === new URL(startUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Smart Proctor',
    backgroundColor: '#ffffff',
    fullscreen: EXAM_MODE,
    kiosk: KIOSK_MODE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !EXAM_MODE,
    },
  });

  if (CONTENT_PROTECTION) mainWindow.setContentProtection(true);

  const wc = mainWindow.webContents;

  // Diagnostics so a blank window always leaves a clue in the log
  wc.on('preload-error', (_e, preloadPath, error) => {
    logEvent('PRELOAD_ERROR', `Preload failed: ${error && error.message}`, { preloadPath });
  });
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || String(failedUrl).startsWith('data:')) return;
    logEvent('PAGE_LOAD_FAILED', `Could not load ${failedUrl}: ${description}`, { code });
    showLoadError(`${description} (${failedUrl})`);
    scheduleRetry();
  });
  wc.on('did-finish-load', () => {
    const current = wc.getURL();
    if (current.startsWith('data:')) return;
    errorShown = false;
    logEvent('PAGE_LOADED', 'Exam page loaded', { url: current });
  });
  wc.on('render-process-gone', (_e, details) => {
    logEvent('RENDERER_CRASHED', `Page process stopped: ${details.reason}`, { reason: details.reason });
    errorShown = false;
    setTimeout(loadApp, 1000);
  });
  mainWindow.on('unresponsive', () => logEvent('WINDOW_UNRESPONSIVE', 'Window stopped responding'));

  loadApp();

  // Focus tracking. Leaving the window is logged, but this alone says NOTHING about what was done elsewhere.
  mainWindow.on('blur', () => {
    blurredAt = Date.now();
    logEvent('WINDOW_BLUR', 'Student left the exam window');
  });
  mainWindow.on('focus', () => {
    if (blurredAt === null) return; // ignore the first focus when the window opens
    const awaySeconds = Math.round((Date.now() - blurredAt) / 1000);
    blurredAt = null;
    logEvent('WINDOW_FOCUS', 'Student returned to the exam window', { awaySeconds });
  });

  // Block popups and navigating away from the exam page
  wc.setWindowOpenHandler(({ url }) => {
    logEvent('POPUP_BLOCKED', 'A new window was blocked', { url });
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      logEvent('NAVIGATION_BLOCKED', 'Navigation away from the exam page was blocked', { url });
    }
  });

  // Exam mode only: block reload / DevTools shortcuts. Cmd+Tab and Cmd+Q are NOT blocked.
  wc.on('before-input-event', (event, input) => {
    if (!EXAM_MODE || input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const blocked =
      input.code === 'F12' ||
      input.code === 'F5' ||
      (mod && input.code === 'KeyR') ||
      (mod && (input.alt || input.shift) && (input.code === 'KeyI' || input.code === 'KeyJ'));
    if (blocked) {
      event.preventDefault();
      logEvent('SHORTCUT_BLOCKED', `Blocked shortcut ${input.code}`, { code: input.code });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC (page <-> main process)
// ============================================================
ipcMain.handle('proctor:get-history', () => history);
ipcMain.handle('proctor:get-status', () => ({
  examMode: EXAM_MODE,
  kioskMode: KIOSK_MODE,
  platform: process.platform,
  violationCount,
  maxViolations: MAX_VIOLATIONS,
  limitReached: limitLogged,
  logFile: getLogFile(),
  devQuit: !app.isPackaged,
}));
ipcMain.on('proctor:activity', (_event, payload) => {
  const type = payload && payload.eventType;
  if (!RENDERER_EVENTS[type]) return;
  const details = {};
  for (const key of ['keystrokes', 'clicks', 'mouseMoves']) {
    const value = payload.details && payload.details[key];
    if (Number.isFinite(value)) details[key] = value;
  }
  logEvent(type, RENDERER_EVENTS[type], details);
});
// Development convenience only. Does nothing in a packaged app.
ipcMain.on('proctor:dev-quit', () => {
  if (!app.isPackaged) app.quit();
});

// ============================================================
// APP START
// ============================================================
function startApp() {
  app.on('second-instance', () => {
    logEvent('SECOND_INSTANCE_BLOCKED', 'A second copy of the app was launched and blocked');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    console.log('Activity log file:', getLogFile());
    logEvent('PROCTOR_STARTED', EXAM_MODE ? 'Started in EXAM mode' : 'Started in DEV mode', {
      platform: process.platform, kiosk: KIOSK_MODE, contentProtection: CONTENT_PROTECTION,
    });

    checkDisplays();
    screen.on('display-added', checkDisplays);
    screen.on('display-removed', checkDisplays);
    screen.on('display-metrics-changed', checkDisplays);

    checkProcesses();
    checkMirroring();
    checkUsb();
    checkActiveWindow();
    setInterval(checkProcesses, PROCESS_INTERVAL_MS);
    setInterval(checkMirroring, HARDWARE_INTERVAL_MS);
    setInterval(checkUsb, HARDWARE_INTERVAL_MS);
    setInterval(checkActiveWindow, ACTIVE_WINDOW_INTERVAL_MS);

    // Development emergency exit (not registered in a packaged app)
    if (!app.isPackaged) {
      globalShortcut.register('Control+Alt+Shift+X', () => app.quit());
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  startApp();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
