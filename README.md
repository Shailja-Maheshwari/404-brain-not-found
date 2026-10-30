# Smart Proctoring Browser (WUElev8 Hackathon)
Team: **404-brain-not-found**

A complete, production-grade AI-proctored examination ecosystem designed for secure, fair, and seamless online assessments.

---

## 1. System Architecture

The project consists of 4 integrated components:
1. **Node.js Express Backend (`proctor-backend`)**:
   - Central REST API server.
   - Dual-database architecture: **Airtable REST API** (Admins, Tests, MCQs) and **MongoDB Atlas** (Roll numbers, Student accounts, Face descriptors, Sessions, Test Attempts, and Proctoring Violations with Snapshots).
   - JWT authentication (`student:login`, `student:test`, `admin`).
   - Email OTP verification via Brevo / Nodemailer with brute-force lock protection.
2. **Student Frontend (`proctor-ui`)**:
   - React 19 + Vite + Tailwind CSS.
   - Student portal with OTP login, dashboard, active Airtable tests, and past test attempt history.
   - Real-time client-side AI proctoring (MediaPipe FaceLandmarker, face-api.js, Web Audio noise detector, Canvas snapshots).
3. **Electron Desktop Browser (`electron/`)**:
   - Secure desktop lockdown browser for students.
   - Sandboxed renderer with `contextIsolation: true`, `nodeIntegration: false`, and IPC preload bridge.
   - Fullscreen/kiosk exam mode, blocks DevTools and reload shortcuts (`F12`, `F5`, `Ctrl+R`, `Ctrl+Shift+I/J`).
   - Detects multiple displays, blocked applications (e.g. ChatGPT desktop, TeamViewer, AnyDesk, OBS, Discord), and navigation attempts.
4. **Admin Dashboard (`proctor-admin`)**:
   - Standalone React 19 + Vite administrative dashboard accessed via standard web browser.
   - Admin email OTP authentication verified against Airtable.
   - Live monitoring of registered students, roll numbers from MongoDB, test attempts, scores, and violation snapshots.

---

## 2. Database Responsibilities

### Airtable — Admins, Tests and MCQs ONLY
Airtable serves as the single source of truth for:
- **`Admins` Table**:
  - `Name`: Admin full name.
  - `Email`: Admin email address (used for admin OTP login).
- **`Tests` Table**:
  - `Title`: Name of the test (e.g., "Aptitude Test").
  - `Duration`: Test duration in minutes.
  - `MCQs`: Linked records to the MCQs table.
  - `Active` *(optional)*: Checkbox to toggle availability.
- **`MCQs` Table**:
  - `Questions`: The question text.
  - `Option A`, `Option B`, `Option C`, `Option D`: Multiple-choice options.
  - `Correct Answer`: The correct option (e.g., `Option B`, `Option A`, or exact text). **Never sent to the student.**
  - `Tests`: Linked record to the associated test.

### MongoDB Atlas — Students, Roll Numbers, Attempts, and Violations
MongoDB Atlas stores all student-related data:
- **Roll Numbers & Student Registration**:
  - Stored strictly in MongoDB (`Student` collection), **NOT** Airtable.
  - Unique index on `regNo` (11-digit roll number).
  - Face reference: 128-dimensional biometric descriptor, registered photo, timestamp.
- **Authentication & Security**:
  - `Otp` collection: SHA-256 hashed OTPs with automatic TTL expiration.
  - `Lock` collection: Account lockout tracking (10 failed attempts triggers a 5-minute lock).
- **Test Attempts**:
  - `Attempt` collection: `regNo`, `testId`, `testTitle`, `sessionId`, `score`, `total`, `answered`, `strikes`, `risk`, `submittedAt`.
- **Proctoring Violations**:
  - `Violation` collection: `attemptId`, `regNo`, `kind`, `severity`, `questionNo`, `riskScore`, `timestamp`, `meta`, `snapshot` (Base64 JPEG).

---

## 3. API Endpoints

### Student Endpoints
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/otp/send` | Sends a 6-digit OTP to student's email |
| `POST` | `/api/auth/otp/verify` | Verifies OTP and returns student JWT token |
| `POST` | `/api/face/register` | Registers face biometric descriptor and photo in MongoDB |
| `POST` | `/api/auth/face-verify` | Verifies live face against MongoDB stored biometric |
| `GET` | `/api/tests` | Returns list of active tests from Airtable |
| `GET` | `/api/tests/:id/questions` | Returns MCQs for a test from Airtable (answers hidden) |
| `POST` | `/api/session/heartbeat` | Keeps test session active |
| `POST` | `/api/test/submit` | Evaluates answers on backend, computes score, saves attempt & violations |
| `GET` | `/api/results/me` | Fetches student's past attempts from MongoDB |

### Admin Endpoints
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/admin/otp/send` | Verifies email in Airtable `Admins` and sends admin OTP |
| `POST` | `/api/admin/otp/verify` | Verifies OTP and returns admin JWT |
| `GET` | `/api/admin/me` | Returns current admin profile |
| `GET` | `/api/admin/students` | Lists all students from MongoDB with face status & latest score |
| `GET` | `/api/admin/students/:regNo` | Detailed student view with all attempts, violations & snapshots |
| `GET` | `/api/admin/records` | Lists all submitted attempts across all students |
| `POST` | `/api/admin/students/:regNo/reset-face` | Resets registered face to permit re-registration |
| `DELETE` | `/api/admin/students/:regNo` | Removes student and their records |
| `DELETE` | `/api/admin/students/:regNo/results` | Clears attempts and violations for a student |

---

## 4. Environment Variables

### Backend (`proctor-backend/.env`)
```env
PORT=5000
NODE_ENV=development

# MongoDB Atlas
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/proctor-db?retryWrites=true&w=majority

# JWT Secret
JWT_SECRET=2e7be0d9c2d4685642a8a4ff6cfb44725cb67148085c03d4be8ec86bd74d29cd

# Airtable Configuration
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app1FGDscypeKRwP0
AIRTABLE_TABLE_ADMINS=Admins
AIRTABLE_TABLE_TESTS=Tests
AIRTABLE_TABLE_MCQS=MCQs

# Email Configuration (Brevo API or SMTP)
BREVO_API_KEY=xkeysib-...
MAIL_FROM=guptapriyanshi522@gmail.com

# CORS Configuration
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174

# Proctoring Config
DEV_SHOW_OTP=true
FACE_THRESHOLD=0.45
LOCK_MINUTES=5
MAX_STRIKES=3
```

### Student Frontend (`proctor-ui/.env`)
```env
VITE_API_URL=http://localhost:5000
```

### Admin Frontend (`proctor-admin/.env`)
```env
VITE_API_URL=http://localhost:5000
```

---

## 5. Commands to Run

### Install Dependencies
```bash
# In workspace root
npm install

# In backend
cd proctor-backend && npm install && cd ..

# In student frontend
cd proctor-ui && npm install && cd ..

# In admin frontend
cd proctor-admin && npm install && cd ..
```

### 1. Start the Backend Server
```bash
cd proctor-backend
npm run dev
# Running on http://localhost:5000
```

### 2. Start the Student Frontend (Web)
```bash
cd proctor-ui
npm run dev
# Running on http://localhost:5173
```

### 3. Start the Admin Website (Web)
```bash
cd proctor-admin
npm run dev
# Running on http://localhost:5174
```

### 4. Run the Electron Desktop Application
In the project root folder:
```bash
# Development mode (connects to Vite dev server or built bundle)
npm run electron

# Exam lockdown mode (fullscreen + blocked shortcuts)
npm run electron:exam
```

### 5. Build and Package the Electron Application
```bash
# 1. Build the student frontend
npm run build:student

# 2. Package the Electron executable (creates installer in dist-electron/)
npm run build:electron
```

### 6. Run Backend Integration Verification Tests
```bash
cd proctor-backend
node Airtable-check.js   # Verifies Airtable connection and tables
node e2etest.js          # Full 21-step E2E integration test suite
```
