import { FaceLandmarker, FilesetResolver }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WEIGHTS = { low: 1, medium: 3, high: 5 };

export class ProctorEngine {
  constructor(videoEl, opts = {}) {
    this.video = videoEl;
    this.cfg = {
      // Timing: a condition must last this long before it counts as a violation
      debounceMs: 3000,        // face / head violations
      gazeDebounceMs: 4000,    // eyes looking away
      audioDebounceMs: 1500,   // noise
      audioGraceMs: 600,       // short dips in noise do not reset the timer
      // Head pose thresholds (difference from the calibrated baseline)
      yawTh: 0.10,
      pitchTh: 0.15,
      // Gaze thresholds (blendshape scores, 0 to 1)
      gazeSideTh: 0.5,
      gazeDownTh: 0.55,
      // Blink thresholds (blendshape scores, 0 = eyes open, 1 = eyes closed)
      blinkCloseTh: 0.3,       // score above this = eyes closed
      blinkOpenTh: 0.15,       // score below this after closing = one blink completed
      // Audio thresholds (tuned values)
      audioMultiplier: 2,      // times louder than the calibrated room noise
      audioMinTh: 0.01,        // quieter than this is never a violation
      enableAudio: true,
      snapshots: true,         // attach a small photo to every violation
      intervalMs: 50,          // ~20 checks per second (fast enough to catch blinks)
      sessionId: "demo-session",
      getQuestionNo: () => null,   // the app tells us which question is on screen
      onEvent: () => {},           // called for every violation
      onStatus: () => {},          // called on every check with the live status
      ...opts,
    };
    this.baseline = null;
    this.calSamples = null;
    this.calAudio = null;
    this.audioBase = 0;
    this.smooth = null;
    this.state = {};
    this.riskScore = 0;
    this.timer = null;
    this.landmarker = null;
    this.stream = null;
    this.audioStream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.audioBuf = null;
    this.smoothLevel = 0;
    this.peakLevel = 0;
    this._liveness = null;
    this._canvas = document.createElement("canvas");
  }

  async start() {
    const vision = await FilesetResolver.forVisionTasks(WASM);
    this.landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 3,
      outputFaceBlendshapes: true, // needed for gaze and blink detection
    });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
    this.video.srcObject = this.stream;
    await this.video.play();

    if (this.cfg.enableAudio) await this._startAudio();

    // setInterval is used instead of requestAnimationFrame so that proctoring
    // keeps running even when the test window is in the background (e.g. tab switching)
    this.timer = setInterval(() => this._tick(), this.cfg.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.audioStream) this.audioStream.getTracks().forEach((t) => t.stop());
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
  }

  // ---------- AUDIO (reads volume level only, nothing is recorded) ----------
  async _startAudio() {
    try {
      // Browser audio processing is turned off on purpose: echo cancellation and
      // noise suppression would remove sounds coming from speakers (e.g. a video).
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await this.audioCtx.resume();
      const src = this.audioCtx.createMediaStreamSource(this.audioStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.audioBuf = new Uint8Array(this.analyser.fftSize);
      src.connect(this.analyser);
    } catch (e) {
      console.warn("Mic not available, audio detection disabled:", e);
      this.analyser = null;
    }
  }

  // Current volume level: RMS of the waveform, roughly 0 to 1
  _audioLevel() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.audioBuf);
    let sum = 0;
    for (let i = 0; i < this.audioBuf.length; i++) {
      const v = (this.audioBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.audioBuf.length);
  }

  // ---------- CALIBRATION: looking straight + normal room noise ----------
  calibrate(ms = 3000) {
    if (this.audioCtx) this.audioCtx.resume();
    return new Promise((resolve) => {
      this.calSamples = [];
      this.calAudio = [];
      this.baseline = null;
      this.peakLevel = 0;
      setTimeout(() => {
        const s = this.calSamples || [];
        const a = this.calAudio || [];
        this.calSamples = null;
        this.calAudio = null;
        if (a.length) this.audioBase = a.reduce((x, y) => x + y, 0) / a.length;
        if (s.length > 10) {
          this.baseline = {
            yaw: s.reduce((x, p) => x + p.yaw, 0) / s.length,
            pitch: s.reduce((x, p) => x + p.pitch, 0) / s.length,
          };
          resolve(true);
        } else resolve(false);
      }, ms);
    });
  }

  // ---------- LIVENESS: user must blink N times before the timeout ----------
  liveness({ blinks = 2, timeoutMs = 10000 } = {}) {
    return new Promise((resolve) => {
      const l = { need: blinks, count: 0, closed: false, timer: null };
      l.done = (ok) => {
        clearTimeout(l.timer);
        if (this._liveness === l) this._liveness = null;
        if (!ok) this._emit("LIVENESS_FAIL", "high", { blinksDone: l.count });
        resolve(ok);
      };
      l.timer = setTimeout(() => l.done(false), timeoutMs);
      this._liveness = l;
    });
  }

  // Counts one blink each time the eyes close and then open again
  _updateLiveness(blink) {
    const l = this._liveness;
    if (!l) return;
    if (blink > this.cfg.blinkCloseTh && !l.closed) {
      l.closed = true;                                   // eyes closed
    } else if (blink < this.cfg.blinkOpenTh && l.closed) {
      l.closed = false;                                  // eyes opened again = one blink
      l.count++;
      if (l.count >= l.need) l.done(true);
    }
  }

  // ---------- HELPERS ----------
  // Head pose from landmarks: 1 = nose tip, 234/454 = cheek edges, 10 = forehead, 152 = chin
  _pose(lm) {
    const yaw = (lm[1].x - lm[234].x) / (lm[454].x - lm[234].x);
    const pitch = (lm[1].y - lm[10].y) / (lm[152].y - lm[10].y);
    const p = { yaw, pitch };
    // Smoothing to reduce frame-to-frame jitter
    if (!this.smooth) this.smooth = { ...p };
    else {
      this.smooth.yaw = this.smooth.yaw * 0.8 + p.yaw * 0.2;
      this.smooth.pitch = this.smooth.pitch * 0.8 + p.pitch * 0.2;
    }
    return this.smooth;
  }

  _blendshapeMap(result) {
    const map = {};
    const cats = result.faceBlendshapes && result.faceBlendshapes[0];
    if (cats) cats.categories.forEach((c) => (map[c.categoryName] = c.score));
    return map;
  }

  // Debounce: true only when the condition has lasted `ms`, and only once per
  // episode. `graceMs` lets the condition dip off briefly without resetting the timer.
  _track(type, active, ms, graceMs = 0) {
    if (!this.state[type]) this.state[type] = { since: null, last: 0, fired: false };
    const s = this.state[type];
    const now = Date.now();
    if (active) {
      s.last = now;
      if (s.since === null) s.since = now;
    } else if (now - s.last >= graceMs) {
      s.since = null;
      s.fired = false;
    }
    if (!s.fired && s.since !== null && now - s.since >= ms) {
      s.fired = true;
      return true;
    }
    return false;
  }

  _snapshot() {
    if (!this.cfg.snapshots || !this.video.videoWidth) return null;
    try {
      const w = 320;
      const h = Math.round((w * this.video.videoHeight) / this.video.videoWidth);
      this._canvas.width = w;
      this._canvas.height = h;
      this._canvas.getContext("2d").drawImage(this.video, 0, 0, w, h);
      return this._canvas.toDataURL("image/jpeg", 0.5);
    } catch (e) {
      return null;
    }
  }

  _emit(type, severity, meta = {}) {
    this.riskScore += WEIGHTS[severity] || 0;
    this.cfg.onEvent({
      sessionId: this.cfg.sessionId,
      type,
      severity,
      timestamp: Date.now(),
      questionNo: this.cfg.getQuestionNo(),
      meta,
      riskScore: this.riskScore,
      snapshot: this._snapshot(),
    });
  }

  // ---------- MAIN LOOP ----------
  _tick() {
    if (!this.landmarker || this.video.readyState < 2) return;
    const result = this.landmarker.detectForVideo(this.video, performance.now());
    const faces = result.faceLandmarks.length;

    let headTurn = false, headDown = false, gazeAway = false;
    let dYaw = 0, dPitch = 0, gazeSide = 0, gazeDown = 0, blinkScore = 0;

    if (faces === 1) {
      const pose = this._pose(result.faceLandmarks[0]);
      const bs = this._blendshapeMap(result);

      if (this.calSamples) this.calSamples.push({ ...pose });

      // Blink score: average of both eyes (0 = open, 1 = closed)
      blinkScore = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
      this._updateLiveness(blinkScore);

      if (this.baseline) {
        dYaw = pose.yaw - this.baseline.yaw;
        dPitch = pose.pitch - this.baseline.pitch;
        headTurn = Math.abs(dYaw) > this.cfg.yawTh;
        headDown = dPitch > this.cfg.pitchTh;
      }

      // Gaze: only checked when the head itself is straight (head turns are caught above)
      const lookLeft = ((bs.eyeLookOutLeft || 0) + (bs.eyeLookInRight || 0)) / 2;
      const lookRight = ((bs.eyeLookInLeft || 0) + (bs.eyeLookOutRight || 0)) / 2;
      gazeSide = Math.max(lookLeft, lookRight);
      gazeDown = ((bs.eyeLookDownLeft || 0) + (bs.eyeLookDownRight || 0)) / 2;
      if (this.baseline && !headTurn && !headDown) {
        gazeAway = gazeSide > this.cfg.gazeSideTh || gazeDown > this.cfg.gazeDownTh;
      }
    }

    // Audio (smoothed level so short dips do not matter)
    const rawLevel = this._audioLevel();
    this.smoothLevel = this.smoothLevel * 0.7 + rawLevel * 0.3;
    if (!this.calSamples && this.smoothLevel > this.peakLevel) this.peakLevel = this.smoothLevel;
    if (this.calAudio) this.calAudio.push(rawLevel);
    const audioTh = Math.max(this.audioBase * this.cfg.audioMultiplier, this.cfg.audioMinTh);
    const audioSpike =
      !!this.analyser && !this.calSamples && this.baseline !== null && this.smoothLevel > audioTh;

    // Live status for the UI (updates instantly, before any debounce delay)
    this.cfg.onStatus({
      faces, headTurn, headDown, gazeAway,
      yawDiff: dYaw, pitchDiff: dPitch,
      gazeSide, gazeDown,
      blinkScore,
      blinksDone: this._liveness ? this._liveness.count : 0,
      audioLevel: this.smoothLevel,
      audioThreshold: audioTh,
      audioPeak: this.peakLevel,
      audioSpike,
      micOn: !!this.analyser,
      calibrated: !!this.baseline,
      calibrating: !!this.calSamples,
      liveness: !!this._liveness,
      riskScore: this.riskScore,
    });

    // Violations (fire only after the debounce time)
    const d = this.cfg.debounceMs;
    if (this._track("NO_FACE", faces === 0, d)) this._emit("NO_FACE", "high");
    if (this._track("MULTIPLE_FACES", faces > 1, d)) this._emit("MULTIPLE_FACES", "high", { faces });
    if (this._track("HEAD_TURN", headTurn, d)) this._emit("HEAD_TURN", "medium");
    if (this._track("HEAD_DOWN", headDown, d)) this._emit("HEAD_DOWN", "medium");
    if (this._track("GAZE_AWAY", gazeAway, this.cfg.gazeDebounceMs)) this._emit("GAZE_AWAY", "low");
    if (this._track("AUDIO_SPIKE", audioSpike, this.cfg.audioDebounceMs, this.cfg.audioGraceMs))
      this._emit("AUDIO_SPIKE", "low", { level: +this.smoothLevel.toFixed(3) });
  }
}