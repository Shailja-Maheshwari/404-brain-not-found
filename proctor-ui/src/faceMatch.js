import * as faceapi
  from "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.esm.js";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/";

export class FaceMatcher {
  constructor(opts = {}) {
    this.cfg = {
      threshold: 0.45,      // distance below this = same person (lower = stricter)
      enrollFrames: 5,      // frames averaged to build the reference
      verifyFrames: 3,      // frames averaged when verifying at login
      frameGapMs: 300,      // pause between captured frames
      minConfidence: 0.5,   // minimum face detection confidence
      ...opts,
    };
    this.loaded = false;
    this.reference = null;  // Float32Array with 128 numbers
  }

  // Loads the three AI models (detector, landmarks, recognition)
  async load() {
    if (this.loaded) return;
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    this.loaded = true;
  }

  // The reference can be saved as a plain array (e.g. in localStorage or a database)
  setReference(arr) {
    this.reference = arr ? new Float32Array(arr) : null;
  }
  getReference() {
    return this.reference ? Array.from(this.reference) : null;
  }
  hasReference() {
    return !!this.reference;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Detects all faces in the current video frame and returns their descriptors
  async _detect(video) {
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: this.cfg.minConfidence,
    });
    return faceapi.detectAllFaces(video, options).withFaceLandmarks().withFaceDescriptors();
  }

  // Captures `count` frames and returns their descriptors.
  // Fails if more than one face is ever seen, or if too few frames contain a face.
  async _collect(video, count) {
    const descriptors = [];
    for (let i = 0; i < count; i++) {
      const faces = await this._detect(video);
      if (faces.length > 1) return { ok: false, reason: "Multiple faces detected. Only one person should be visible." };
      if (faces.length === 1) descriptors.push(faces[0].descriptor);
      await this._sleep(this.cfg.frameGapMs);
    }
    if (descriptors.length < Math.ceil(count / 2)) {
      return { ok: false, reason: "Face not clearly visible. Improve lighting and look at the camera." };
    }
    return { ok: true, descriptors };
  }

  // Registration step: builds the reference descriptor from the live camera
  async enroll(video) {
    await this.load();
    const res = await this._collect(video, this.cfg.enrollFrames);
    if (!res.ok) return res;
    // Average all descriptors into one reference
    const avg = new Float32Array(128);
    res.descriptors.forEach((d) => d.forEach((v, i) => (avg[i] += v / res.descriptors.length)));
    this.reference = avg;
    return { ok: true };
  }

  // Login step: compares the live face with the stored reference (averaged over a few frames)
  async verify(video) {
    if (!this.reference) return { ok: false, reason: "No reference face enrolled yet." };
    await this.load();
    const res = await this._collect(video, this.cfg.verifyFrames);
    if (!res.ok) return res;
    const distances = res.descriptors.map((d) => faceapi.euclideanDistance(d, this.reference));
    const distance = distances.reduce((a, b) => a + b, 0) / distances.length;
    return { ok: true, match: distance < this.cfg.threshold, distance };
  }

  // Quick single-frame identity check used during the test.
  // Returns how many faces were seen, and whether the (single) face matches the reference.
  async check(video) {
    if (!this.reference) return { ok: false, faces: 0 };
    await this.load();
    const faces = await this._detect(video);
    if (faces.length !== 1) return { ok: true, faces: faces.length };
    const distance = faceapi.euclideanDistance(faces[0].descriptor, this.reference);
    return { ok: true, faces: 1, match: distance < this.cfg.threshold, distance };
  }
}