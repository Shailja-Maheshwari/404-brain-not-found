const express = require("express");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Student = require("../models/Student");

const router = express.Router();

// Middleware: Admin Token Check
const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Token expired or invalid" });
  }
};

// 1. Send OTP
router.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    let admin = await Admin.findOne({ email });
    if (!admin) {
      admin = new Admin({ email });
    }

    if (admin.isBlocked) {
      return res.status(403).json({ error: "Account blocked due to 10 failed attempts." });
    }

    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
    admin.otp = generatedOtp;
    admin.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await admin.save();

    console.log(`🔑 OTP for ${email}: ${generatedOtp}`);

    res.json({ message: "OTP sent", debugOtp: generatedOtp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Verify OTP
router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const admin = await Admin.findOne({ email });

    if (!admin) return res.status(404).json({ error: "Admin not found" });
    if (admin.isBlocked) return res.status(403).json({ error: "Account blocked!" });

    if (admin.otp !== otp || new Date() > admin.otpExpiresAt) {
      admin.failedOtpAttempts += 1;
      if (admin.failedOtpAttempts >= 10) {
        admin.isBlocked = true;
        await admin.save();
        return res.status(403).json({ error: "Account blocked! 10 failed attempts reached." });
      }
      await admin.save();
      return res.status(400).json({
        error: `Invalid OTP. Attempts left: ${10 - admin.failedOtpAttempts}`
      });
    }

    admin.failedOtpAttempts = 0;
    admin.otp = null;
    admin.otpExpiresAt = null;
    await admin.save();

    const token = jwt.sign({ email: admin.email, id: admin._id }, process.env.JWT_SECRET, {
      expiresIn: "24h"
    });

    res.json({ token, email: admin.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get All Students
router.get("/students", verifyAdminToken, async (req, res) => {
  try {
    const students = await Student.find();
    res.json({ students });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Single Student
router.get("/students/:regNo", verifyAdminToken, async (req, res) => {
  try {
    const student = await Student.findOne({ regNo: req.params.regNo });
    if (!student) return res.status(404).json({ error: "Student not found" });

    res.json({
      student,
      attempts: student.attempts.sort((a, b) => b.submittedAt - a.submittedAt)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Reset Face
router.post("/students/:regNo/reset-face", verifyAdminToken, async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { regNo: req.params.regNo },
      { faceRegistered: false, facePhotoUrl: null, registeredAt: null },
      { new: true }
    );
    res.json({ message: "Face reset success", student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Delete Results
router.delete("/students/:regNo/results", verifyAdminToken, async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { regNo: req.params.regNo },
      { attempts: [] },
      { new: true }
    );
    res.json({ message: "Results deleted", student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;