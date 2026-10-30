const express = require("express");
const router = express.Router();
const base = require("../config/airtable");
const Student = require("../models/Student");

// Fetch Questions from Airtable
router.get("/questions", async (req, res) => {
  try {
    const records = await base(process.env.AIRTABLE_TABLE_NAME || "Questions")
      .select({ view: "Grid view" })
      .all();

    const questions = records.map((record) => ({
      id: record.id,
      questionNo: record.get("QuestionNo"),
      questionText: record.get("Question"),
      options: [
        record.get("OptionA"),
        record.get("OptionB"),
        record.get("OptionC"),
        record.get("OptionD")
      ].filter(Boolean)
    }));

    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: "Failed to load questions from Airtable" });
  }
});

// Submit Test & Evaluate Score
router.post("/submit", async (req, res) => {
  try {
    const { regNo, testName, answers, events, strikes, risk } = req.body;

    const records = await base(process.env.AIRTABLE_TABLE_NAME || "Questions")
      .select()
      .all();

    let score = 0;
    const total = records.length;

    records.forEach((record) => {
      const qId = record.id;
      const correctAnswer = record.get("CorrectAnswer");
      const studentSelected = answers ? answers[qId] : null;

      if (studentSelected && studentSelected === correctAnswer) {
        score += 1;
      }
    });

    const student = await Student.findOne({ regNo });
    if (!student) return res.status(404).json({ error: "Student not found" });

    const newAttempt = {
      testName: testName || "Online Exam",
      submittedAt: new Date(),
      score,
      total,
      answered: answers ? Object.keys(answers).length : 0,
      strikes: strikes || 0,
      risk: risk || 0,
      eventCount: events ? events.length : 0,
      events: events || []
    };

    student.attempts.push(newAttempt);
    await student.save();

    res.json({ message: "Test submitted successfully", score, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;