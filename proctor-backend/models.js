// MongoDB collections (Mongoose models).
// Everything the app needs to remember is stored here:
// students (face data), OTPs, login locks, test attempts and violations (with snapshots).
const mongoose = require("mongoose");
const { Schema } = mongoose;

const Face = new Schema(
  { descriptor: [Number], photo: String, registeredAt: Date },
  { _id: false }
);
const Session = new Schema({ id: String, lastSeen: Date }, { _id: false });

// A student document is created at the first successful OTP login (self-registration).
// One registration number is bound to one email (both are unique).
const Student = mongoose.model(
  "Student",
  new Schema(
    {
      regNo: { type: String, required: true, unique: true },
      name: String,
      email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
      face: { type: Face, default: undefined },       // saved once per student
      session: { type: Session, default: undefined }, // the one active test session
    },
    { timestamps: true }
  )
);

// One OTP per key ("student:<regNo>:<email>" or "admin:<email>"). Only a hash is stored.
// The TTL index removes expired OTPs automatically.
const Otp = mongoose.model(
  "Otp",
  new Schema({
    key: { type: String, required: true, unique: true },
    hash: String,
    attempts: { type: Number, default: 0 },
    sentAt: Date,
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
  })
);

// Wrong-attempt counter and lock (10 wrong tries = 5 minute lock)
const Lock = mongoose.model(
  "Lock",
  new Schema({
    key: { type: String, required: true, unique: true },
    fails: { type: Number, default: 0 },
    until: { type: Date, default: null },
  })
);

// One document per submitted test
const Attempt = mongoose.model(
  "Attempt",
  new Schema({
    regNo: { type: String, index: true },
    testId: String,
    testTitle: String,
    sessionId: { type: String, unique: true }, // a session can submit only once
    submittedAt: { type: Date, default: Date.now, index: true },
    score: Number,
    total: Number,
    answered: Number,
    reason: String,
    strikes: Number,
    risk: Number,
    eventCount: Number,
  })
);

// One document per violation, with its snapshot (a small JPEG as a data URL)
const Violation = mongoose.model(
  "Violation",
  new Schema({
    attemptId: { type: Schema.Types.ObjectId, index: true },
    regNo: String,
    kind: String, // the violation type, for example HEAD_TURN
    severity: String,
    timestamp: Number,
    questionNo: Number,
    riskScore: Number,
    meta: Schema.Types.Mixed,
    snapshot: String,
  })
);

// One document per identity verification attempt before starting every test
const Verification = mongoose.model(
  "Verification",
  new Schema(
    {
      regNo: { type: String, required: true, index: true },
      studentId: { type: Schema.Types.ObjectId, ref: "Student" },
      studentName: String,
      studentEmail: String,
      testId: { type: String, required: true, index: true },
      testTitle: String,
      status: {
        type: String,
        enum: ["passed", "failed", "pending_review", "admin_approved"],
        required: true,
        index: true,
      },
      verifiedAt: { type: Date, default: Date.now, index: true },
      distance: Number,
      threshold: Number,
      photo: String, // base64 face snapshot captured during verification
      failureReason: String,
      adminNotes: String,
      reviewedBy: String,
      reviewedAt: Date,
    },
    { timestamps: true }
  )
);

// One document per examination activity event (window blur, focus return, tab switches, blocked apps)
const ActivityLog = mongoose.model(
  "ActivityLog",
  new Schema(
    {
      regNo: { type: String, required: true, index: true },
      studentId: { type: Schema.Types.ObjectId, ref: "Student" },
      testId: { type: String, required: true, index: true },
      testTitle: String,
      sessionId: { type: String, index: true },
      eventType: { type: String, required: true, index: true },
      timestamp: { type: Date, default: Date.now, index: true },
      tabTitle: { type: String, default: "" },
      tabUrl: { type: String, default: "" },
      duration: { type: Number, default: 0 }, // seconds away from the exam window
      metadata: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
  )
);

module.exports = { Student, Otp, Lock, Attempt, Violation, Verification, ActivityLog };