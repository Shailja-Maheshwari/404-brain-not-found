const { app, BrowserWindow, screen, ipcMain, globalShortcut, Notification, session } = require('electron');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ============================================================
// SETTINGS & CONFIGURATION
// ============================================================
const args = process.argv.slice(1);
const isExamArg = args.includes('--exam');
const isDevArg = args.includes('--dev');

// Exam mode: fullscreen + blocked DevTools & reload shortcuts
const EXAM_MODE = isExamArg || process.env.EXAM_MODE === 'true';
const KIOSK_MODE = false;
const CONTENT_PROTECTION = process.env.CONTENT_PROTECTION === 'true';

if (process.env.NO_GPU === 'true') app.disableHardwareAcceleration();

// Candidates to check for student frontend dev server
const DEV_URL_CANDIDATES = process.env.START_URL
  ? [process.env.START_URL]
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

const MAX_VIOLATIONS = Number(process.env.MAX_VIOLATIONS) > 0 ? Number(process.env.MAX_VIOLATIONS) : 3;

// Events that count toward strikes/violations
const COUNTED_EVENTS = new Set([
  'EXTRA_DISPLAY_DETECTED',
  'SCREEN_MIRRORING_DETECTED',
  'BLOCKED_APP_DETECTED',
  'SECOND_INSTANCE_BLOCKED',
  'CLIPBOARD_PASTE_BLOCKED',
  'WINDOW_BLUR',
]);

const FLAG_EVENTS = new Set([
  'AI_SITE_ACTIVE',
  'AI_SITE_LEFT',
  'AI_APP_ACTIVE',
  'AI_APP_RUNNING',
  'WEB_SEARCH_DETECTED',
  'UNSUPPORTED_BROWSER_ACTIVE',
  'EXTERNAL_DEVICE_CONNECTED',
  'CLIPBOARD_COPY_BLOCKED',
  'CLIPBOARD_CUT_BLOCKED',
  'CONTEXT_MENU_BLOCKED',
]);

const AI_SITES = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'claude.ai', 'gemini.google.com',
  'copilot.microsoft.com', 'perplexity.ai', 'deepseek.com', 'poe.com', 'grok.com',
];

const SEARCH_ENGINES = [
  { test: (h) => /(^|\.)google\.[a-z.]+$/.test(h), param: 'q' },
  { test: (h) => h.endsWith('bing.com'), param: 'q' },
  { test: (h) => h.endsWith('duckduckgo.com'), param: 'q' },
  { test: (h) => h.endsWith('search.yahoo.com'), param: 'p' },
  { test: (h) => h.endsWith('youtube.com'), param: 'search_query' },
];

const BROWSERS = {
  'Google Chrome': 'chromium',
  'Brave Browser': 'chromium',
  'Microsoft Edge': 'chromium',
  Vivaldi: 'chromium',
  Chromium: 'chromium',
  Safari: 'safari',
};

const UNSUPPORTED_BROWSERS = ['Firefox', 'Arc', 'Opera', 'Tor Browser', 'DuckDuckGo'];
const OWN_NAMES = new Set(['electron', 'smart proctor', 'smart-proctor', 'deviathon']);

const WATCHED_APPS = [
  { label: 'ChatGPT desktop app', eventType: 'AI_APP_RUNNING', match: ['/chatgpt.app/', 'chatgpt.exe'] },
  { label: 'Claude desktop app', eventType: 'AI_APP_RUNNING', match: ['/claude.app/', 'claude.exe'] },
  { label: 'TeamViewer', eventType: 'BLOCKED_APP_DETECTED', match: ['/teamviewer.app/', 'teamviewer.exe'] },
  { label: 'AnyDesk', eventType: 'BLOCKED_APP_DETECTED', match: ['/anydesk.app/', 'anydesk.exe'] },
  { label: 'Zoom', eventType: 'BLOCKED_APP_DETECTED', match: ['/zoom.us.app/', 'zoom.exe'] },
  { label: 'OBS (recording/streaming)', eventType: 'BLOCKED_APP_DETECTED', match: ['/obs.app/', 'obs64.exe', 'obs32.exe'] },
  { label: 'Discord', eventType: 'BLOCKED_APP_DETECTED', match: ['/discord.app/', 'discord.exe'] },
];

const ACTIVE_WINDOW_INTERVAL_MS = 2500;
const PROCESS_INTERVAL_MS = 5000;
const HARDWARE_INTERVAL_MS = 15000;

const RENDERER_EVENTS = {
  CLIPBOARD_COPY_BLOCKED: 'Copy attempt blocked',
  CLIPBOARD_CUT_BLOCKED: 'Cut attempt blocked',
  CLIPBOARD_PASTE_BLOCKED: 'Paste attempt blocked',
  CONTEXT_MENU_BLOCKED: 'Right-click menu blocked',
  INPUT_ACTIVITY_SUMMARY: 'Input activity summary',
};

// ============================================================
// STATE + LOGGING
// ============================================================
let mainWindow = null;
let startUrl = DEV_URL_CANDIDATES[0];
let usingLocalFile = false;
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

  console.log(`[Proctor Log] [${severity.toUpperCase()}] ${eventType}: ${message}`);
  fs.appendFile(getLogFile(), line + '\n', () => {});
  history.push(entry);
  if (history.length > 500) history.shift();
  sendToWindow('proctor:event', entry);

  if (severity === 'violation') {
    violationCount += 1;
    const limitReached = violationCount >= MAX_VIOLATIONS;
    sendToWindow('proctor:violation', { count: violationCount, max: MAX_VIOLATIONS, message, limitReached });
    notifyStudent(limitReached ? 'Violation limit reached' : `Warning ${violationCount} of ${MAX_VIOLATIONS}`, message);
    if (limitReached && !limitLogged) {
      limitLogged = true;
      logEvent('VIOLATION_LIMIT_REACHED', `Violation limit (${MAX_VIOLATIONS}) reached`);
    }
  }
}

function notifyStudent(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (error) {}
}

function logOnce(key, eventType, message, details) {
  if (reportedOnce.has(key)) return;
  reportedOnce.add(key);
  logEvent(eventType, message, details);
}

function runCommand(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        out: (stdout || '').trim(),
        error: error ? (stderr || error.message).trim() : '',
      });
    });
  });
}

// ============================================================
// SYSTEM MONITORS (PROCESSES & WINDOWS)
// ============================================================
const foundApps = new Set();

async function checkProcesses() {
  const isWin = process.platform === 'win32';
  const result = isWin
    ? await runCommand('tasklist', ['/fo', 'csv', '/nh'])
    : await runCommand('ps', ['-axo', 'comm=']);
  if (!result.ok) return;

  const text = result.out.toLowerCase();
  for (const item of WATCHED_APPS) {
    const running = item.match.some((m) => text.includes(m.toLowerCase()));
    if (running && !foundApps.has(item.label)) {
      foundApps.add(item.label);
      logEvent(item.eventType, `${item.label} detected running on student machine`, { app: item.label });
    } else if (!running && foundApps.has(item.label)) {
      foundApps.delete(item.label);
      logEvent('WATCHED_APP_CLOSED', `${item.label} was closed`, { app: item.label });
    }
  }
}

let lastActiveWindow = '';
async function checkActiveWindow() {
  if (process.platform === 'darwin') {
    checkActiveWindowMac();
  } else if (process.platform === 'win32') {
    checkActiveWindowWin();
  }
}

function checkActiveWindowWin() {
  // Check active window title on Windows via PowerShell
  const psCmd = `powershell -NoProfile -Command "(Get-Process | Where-Object { $_.MainWindowHandle -eq [System.IntPtr]::Zero -or $_.MainWindowTitle -ne '' } | Sort-Object CPU -Descending | Select-Object -First 1).MainWindowTitle"`;
  exec(psCmd, { timeout: 2000 }, (err, stdout) => {
    if (err || !stdout) return;
    const title = stdout.trim();
    if (!title || title === lastActiveWindow) return;
    lastActiveWindow = title;

    const lower = title.toLowerCase();
    if (lower.includes('chatgpt') || lower.includes('claude') || lower.includes('gemini') || lower.includes('copilot') || lower.includes('deepseek')) {
      logEvent('AI_SITE_ACTIVE', `AI tool window detected: ${title}`, { windowTitle: title });
    }
  });
}

function getHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function matchesDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}
function isAiHost(host) {
  return AI_SITES.some((d) => matchesDomain(host, d));
}

let lastActiveKey = '';
let checkingActive = false;
let aiSession = null;

function endAiSession() {
  if (!aiSession) return;
  const seconds = Math.round((Date.now() - aiSession.since) / 1000);
  logEvent('AI_SITE_LEFT', `Left AI site ${aiSession.host} after ${seconds}s`, { host: aiSession.host, seconds });
  aiSession = null;
}

async function checkActiveWindowMac() {
  if (checkingActive) return;
  checkingActive = true;
  try {
    const FRONT_SCRIPT =
      'tell application "System Events"\n' +
      'set p to first application process whose frontmost is true\n' +
      'return (name of p) & "|||" & (unix id of p)\n' +
      'end tell';
    const front = await runCommand('osascript', ['-e', FRONT_SCRIPT]);
    if (!front.ok) return;

    const sep = front.out.indexOf('|||');
    const appName = sep >= 0 ? front.out.slice(0, sep) : front.out;
    const pid = sep >= 0 ? Number(front.out.slice(sep + 3)) : NaN;

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
        logEvent('AI_APP_ACTIVE', `${appName} desktop app is in foreground`, { app: appName });
      }
      return;
    }

    if (isAiHost(host)) {
      if (!aiSession) aiSession = { host, since: Date.now() };
      logEvent('AI_SITE_ACTIVE', `AI site active in browser tab: ${host}`, { app: appName, host, title, url });
    } else {
      logEvent('ACTIVE_TAB_CHANGED', `${appName}: ${host}`, { app: appName, host, title });
    }
  } finally {
    checkingActive = false;
  }
}

// ============================================================
// CHECK DISPLAYS & HARDWARE
// ============================================================
let lastDisplayCount = null;

function checkDisplays() {
  const displays = screen.getAllDisplays();
  const count = displays.length;
  if (count === lastDisplayCount) return;
  const before = lastDisplayCount;
  lastDisplayCount = count;

  if (count > 1) {
    logEvent('EXTRA_DISPLAY_DETECTED', `${count} monitors detected. Multiple displays are prohibited during the exam.`, {
      displayCount: count,
    });
  } else if (before === null) {
    logEvent('DISPLAY_CHECK', 'Single display verified', { displayCount: count });
  } else {
    logEvent('EXTRA_DISPLAY_REMOVED', 'Returned to a single display', { displayCount: count });
  }
}

// ============================================================
// WINDOW CREATION & APP LOADING
// ============================================================
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function findStartUrl() {
  for (const url of DEV_URL_CANDIDATES) {
    if (await probe(url)) return url;
  }
  return null;
}

function getProductionBuildPath() {
  const paths = [
    path.join(__dirname, '../proctor-ui/dist/index.html'),
    path.join(__dirname, '../../proctor-ui/dist/index.html'),
    path.join(__dirname, '../dist/index.html'),
    path.join(app.getAppPath(), 'proctor-ui/dist/index.html'),
    path.join(app.getAppPath(), 'dist/index.html'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    loadApp();
  }, 3000);
}

function showLoadError(detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `<!doctype html>
  <html>
    <head><meta charset="utf-8"><title>Smart Proctor Setup</title></head>
    <body style="font-family:sans-serif;padding:40px;max-width:760px;margin:auto;color:#1e293b;line-height:1.6">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;padding:24px;margin-bottom:24px">
        <h2 style="color:#1d4ed8;margin-top:0">Smart Proctor - Student Desktop Browser</h2>
        <p>Waiting for the Student Frontend...</p>
        <p style="font-size:14px;color:#64748b">Detail: ${detail}</p>
      </div>
      <h3>To connect the Student Frontend:</h3>
      <ol style="padding-left:20px;font-size:15px">
        <li><strong>Development Mode:</strong> Run <code>cd proctor-ui && npm run dev</code> in a terminal.</li>
        <li><strong>Production Mode:</strong> Run <code>cd proctor-ui && npm run build</code> to build the production assets.</li>
      </ol>
      <p style="color:#64748b;font-size:13px">This window will automatically detect the server and connect every 3 seconds.</p>
    </body>
  </html>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
}

async function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 1. Try dev server first if not explicitly packaged
  if (!app.isPackaged) {
    const url = await findStartUrl();
    if (url) {
      startUrl = url;
      usingLocalFile = false;
      mainWindow.loadURL(url).catch(() => {});
      return;
    }
  }

  // 2. Try production build file
  const prodFile = getProductionBuildPath();
  if (prodFile) {
    usingLocalFile = true;
    startUrl = 'file://' + prodFile;
    mainWindow.loadFile(prodFile).catch(() => {});
    return;
  }

  // 3. Neither ready yet, show helpful setup screen and retry
  logOnce('no-dev-server', 'PAGE_LOAD_WAITING', 'Waiting for Student UI (Vite dev server or build)...');
  showLoadError('Neither the Vite dev server (http://localhost:5173) nor the production build (proctor-ui/dist/index.html) was found.');
  scheduleRetry();
}

function isAllowedUrl(u) {
  try {
    if (usingLocalFile && u.startsWith('file://')) return true;
    return new URL(u).origin === new URL(startUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: 'Smart Proctoring Browser',
    backgroundColor: '#ffffff',
    fullscreen: EXAM_MODE,
    kiosk: KIOSK_MODE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: !EXAM_MODE,
    },
  });

  if (CONTENT_PROTECTION) mainWindow.setContentProtection(true);

  const wc = mainWindow.webContents;

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
    logEvent('PAGE_LOADED', 'Student exam page loaded', { url: current });
  });

  wc.on('render-process-gone', (_e, details) => {
    logEvent('RENDERER_CRASHED', `Renderer process exited: ${details.reason}`, { reason: details.reason });
    setTimeout(loadApp, 1000);
  });

  // Track window focus / blur
  mainWindow.on('blur', () => {
    blurredAt = Date.now();
    logEvent('WINDOW_BLUR', 'Student navigated away from the exam browser');
  });

  mainWindow.on('focus', () => {
    if (blurredAt === null) return;
    const awaySec = Math.round((Date.now() - blurredAt) / 1000);
    blurredAt = null;
    logEvent('WINDOW_FOCUS', 'Student returned to the exam browser', { awaySeconds: awaySec });
  });

  // Security restrictions: Block external window open and navigation outside student app
  wc.setWindowOpenHandler(({ url }) => {
    logEvent('POPUP_BLOCKED', 'External popup window was blocked', { url });
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      logEvent('NAVIGATION_BLOCKED', 'Navigation outside the exam application was blocked', { url });
    }
  });

  // In exam mode, block refresh shortcuts and DevTools
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
      logEvent('SHORTCUT_BLOCKED', `Blocked shortcut key: ${input.code}`, { code: input.code });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  loadApp();
}

// ============================================================
// IPC (PAGE <-> MAIN PROCESS)
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
    const val = payload.details && payload.details[key];
    if (Number.isFinite(val)) details[key] = val;
  }
  logEvent(type, RENDERER_EVENTS[type], details);
});

ipcMain.on('proctor:dev-quit', () => {
  if (!app.isPackaged) app.quit();
});

// ============================================================
// APP STARTUP
// ============================================================
function startApp() {
  app.on('second-instance', () => {
    logEvent('SECOND_INSTANCE_BLOCKED', 'A second copy of Smart Proctor was launched and prevented');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Auto-approve webcam and microphone permissions for AI proctoring
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (['media', 'camera', 'microphone'].includes(permission)) {
        return callback(true);
      }
      callback(false);
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (['media', 'camera', 'microphone'].includes(permission)) {
        return true;
      }
      return false;
    });

    createWindow();
    console.log('[Smart Proctor] Running on platform:', process.platform);
    console.log('[Smart Proctor] Activity log file:', getLogFile());

    logEvent('PROCTOR_STARTED', EXAM_MODE ? 'Started in EXAM mode' : 'Started in DEV mode', {
      platform: process.platform, kiosk: KIOSK_MODE, contentProtection: CONTENT_PROTECTION,
    });

    checkDisplays();
    screen.on('display-added', checkDisplays);
    screen.on('display-removed', checkDisplays);
    screen.on('display-metrics-changed', checkDisplays);

    checkProcesses();
    checkActiveWindow();
    setInterval(checkProcesses, PROCESS_INTERVAL_MS);
    setInterval(checkActiveWindow, ACTIVE_WINDOW_INTERVAL_MS);

    // Development emergency exit: Ctrl+Alt+Shift+X
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
