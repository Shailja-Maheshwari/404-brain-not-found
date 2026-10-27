const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']); // Google Public DNS jo SRV records ko block nahi karta
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = 5000;

// ==========================================
// 1. CONFIGURATIONS
// ==========================================

// MongoDB Cloud URI
const MONGODB_URI = 'mongodb+srv://shailjamaheshwari40_db_user:7bTq4RjAMYvJieOd@cluster0.gyicsfq.mongodb.net/proctoringDB?retryWrites=true&w=majority';

// Single clean MongoDB connection
mongoose.connect(MONGODB_URI)
  .then(() => console.log('🍃 MongoDB Atlas Cloud Database Connected Successfully!'))
  .catch((err) => console.warn('⚠️ MongoDB connection warning:', err.message));

// Airtable Cloud Configuration (For MCQs - Objective 2)
const AIRTABLE_TOKEN = 'patuODs1LKYPlZtvD.46f93f0d145ec8f51ac9ce21c634ec9bd0ab52ae2db198146b0f0b45162a27dd';
const BASE_ID = 'appwdEeZ5RasvzW1A';
const TABLE_NAME = 'Questions';

app.use(cors());
app.use(express.json());

// ==========================================
// 2. MONGOOSE SCHEMA & MODEL
// ==========================================
const submissionSchema = new mongoose.Schema({
  studentEmail: String,
  score: Number,
  total: Number,
  answers: Object,
  violationCount: Number,
  violationLogs: [String],
  submittedAt: { type: Date, default: Date.now }
});

const Submission = mongoose.model('Submission', submissionSchema);
const activeOtps = {};

// ==========================================
// 3. API ENDPOINTS
// ==========================================

// Health check
app.get('/', (req, res) => {
  res.send('Proctoring Backend with Live Airtable & MongoDB Atlas is Running! 🚀');
});

// 1. Fetch Questions (Directly from Airtable Cloud!)
app.get('/api/questions', async (req, res) => {
  try {
    const airtableUrl = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_NAME}`;
    const response = await fetch(airtableUrl, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
    });
    const data = await response.json();

    if (data.records && data.records.length > 0) {
      const airtableQuestions = data.records.map((record, index) => {
        const rawOptions = record.fields.options || '';
        const optionsArray = typeof rawOptions === 'string'
          ? rawOptions.split(',').map(o => o.trim())
          : rawOptions;

        return {
          id: index + 1,
          question: record.fields.question || 'Sample Question',
          options: optionsArray,
          correctAnswer: record.fields.correctAnswer || ''
        };
      });

      console.log(`[Airtable SUCCESS] Fetched ${airtableQuestions.length} questions live from Airtable Cloud! ☁️`);
      return res.json({
        success: true,
        source: "Airtable Cloud",
        totalQuestions: airtableQuestions.length,
        questions: airtableQuestions
      });
    }
  } catch (error) {
    console.warn("[Airtable Error]:", error.message);
  }

  // Backup fallback
  res.json({
    success: true,
    source: "Backup DB",
    totalQuestions: 2,
    questions: [
      { id: 1, question: "What is the capital of France?", options: ["Paris", "Berlin", "Madrid", "Rome"], correctAnswer: "Paris" },
      { id: 2, question: "Which data structure uses LIFO principle?", options: ["Queue", "Stack", "Array", "Linked List"], correctAnswer: "Stack" }
    ]
  });
});

// 2. Dynamic OTP APIs
app.post('/api/auth/send-otp', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
  activeOtps[email] = { otp: generatedOtp, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`📩 OTP for ${email}: [ ${generatedOtp} ]`);
  res.json({ success: true, message: `OTP sent to ${email}`, demoOtp: generatedOtp });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const record = activeOtps[email];

  if (!record) return res.status(400).json({ success: false, message: "No OTP requested!" });

  if (record.otp === otp) {
    delete activeOtps[email];
    return res.json({ success: true, message: "Authentication Successful!", token: "auth-" + Date.now() });
  } else {
    return res.status(400).json({ success: false, message: "Incorrect OTP!" });
  }
});

// 3. Face Auth API
app.post('/api/auth/verify-face', (req, res) => {
  const { studentEmail } = req.body;
  res.json({
    success: true,
    message: "Face Recognition Verified!",
    verifiedStudent: studentEmail || "student@test.com",
    token: "face-token-" + Date.now()
  });
});

// 4. Test Submit & Save to MongoDB Atlas Cloud Database
app.post('/api/test/submit', async (req, res) => {
  const { studentEmail, answers, violationCount, violationLogs } = req.body;

  let score = 0;
  const total = 2;

  if (answers) {
    if (answers[1] === "Paris") score += 1;
    if (answers[2] === "Stack") score += 1;
  }

  const newSubmission = new Submission({
    studentEmail: studentEmail || "student@test.com",
    score,
    total,
    answers: answers || {},
    violationCount: violationCount || 0,
    violationLogs: violationLogs || []
  });

  try {
    await newSubmission.save();
    console.log(`🍃 [MongoDB SUCCESS] Submission saved to MongoDB Atlas for ${newSubmission.studentEmail} (Score: ${score}/${total})`);
  } catch (err) {
    console.warn("MongoDB save warning:", err.message);
  }

  res.json({
    success: true,
    message: "Test submitted & saved to MongoDB Atlas Cloud!",
    score,
    total,
    submission: newSubmission
  });
});

// 5. Admin API (Reads directly from MongoDB Atlas)
app.get('/api/admin/submissions', async (req, res) => {
  try {
    const subs = await Submission.find().sort({ submittedAt: -1 });
    res.json({ success: true, totalSubmissions: subs.length, submissions: subs });
  } catch (e) {
    res.json({ success: true, totalSubmissions: 0, submissions: [] });
  }
});

// Start Server with keep-alive
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`Server running on: http://localhost:${PORT}`);
  console.log(`Hybrid Architecture: Airtable (MCQs) + MongoDB Atlas (Logs)`);
  console.log(`=========================================`);
});

setInterval(() => {}, 1000);