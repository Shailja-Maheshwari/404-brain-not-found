# 🚀 Smart Proctoring System – Production Deployment Guide

This guide provides step-by-step instructions for deploying all components of the Smart Proctoring System to production.

---

## 🏗️ Architecture Overview

The system consists of 4 main components:
1. **`proctor-backend`**: Node.js & Express REST API with MongoDB Atlas & Airtable.
2. **`proctor-ui`**: Student Examination Web Portal (Vite + React SPA).
3. **`proctor-admin`**: Proctor & Supervisor Monitoring Dashboard (Vite + React SPA).
4. **Electron Desktop Client**: Secure locked-down examination browser packaged into a Windows `.exe` installer.

---

## ⚡ Recommended Deployment Stack

| Component | Recommended Platform | Alternative |
| :--- | :--- | :--- |
| **Backend API** | **[Render](https://render.com)** (Web Service) | Railway, Koyeb, AWS EC2 |
| **Student UI** | **[Vercel](https://vercel.com)** | Netlify, Render Static Site |
| **Admin UI** | **[Vercel](https://vercel.com)** | Netlify, Render Static Site |
| **Electron App** | **`electron-builder`** (Generates `.exe`) | GitHub Releases / Drive Link |

---

## Step 1: Deploy Backend API (`proctor-backend`)

### Option A: Using Render (Recommended)
1. Push your latest code to your GitHub repository:
   ```bash
   git push origin main
   ```
2. Log in to [Render Dashboard](https://dashboard.render.com/) and click **New +** > **Web Service**.
3. Select your GitHub repository (`404-brain-not-found`).
4. Configure the service:
   - **Name:** `smart-proctor-backend`
   - **Region:** Singapore / Frankfurt / Oregon (nearest to your users)
   - **Root Directory:** `proctor-backend`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free (or Starter)
5. Under **Environment Variables**, add the following from your `.env`:
   - `NODE_ENV`: `production`
   - `PORT`: `5000` (or leave default, Render sets this automatically)
   - `MONGODB_URI`: `mongodb+srv://priyanshi-gupta:priyanshi1108@proctor-db.nqpbzxe.mongodb.net/proctor-db?retryWrites=true&w=majority`
   - `JWT_SECRET`: *(A secure 32+ character string, e.g. from your .env)*
   - `AIRTABLE_API_KEY`: *(Your Airtable Personal Access Token)*
   - `AIRTABLE_BASE_ID`: `app1FGDscypeKRwP0`
   - `AIRTABLE_TABLE_ROLL`: `Roll`
   - `AIRTABLE_TABLE_ADMINS`: `Admins`
   - `AIRTABLE_TABLE_TESTS`: `Tests`
   - `AIRTABLE_TABLE_MCQS`: `MCQs`
   - `BREVO_API_KEY`: *(Your Brevo API Key for sending student OTPs)*
   - `MAIL_FROM`: `guptapriyanshi522@gmail.com`
   - `FACE_THRESHOLD`: `0.45`
   - `MAX_STRIKES`: `3`
   - `CORS_ORIGINS`: `https://your-student-portal.vercel.app,https://your-admin-portal.vercel.app`
6. Click **Create Web Service**.
7. Once deployed, note your backend URL (e.g. `https://smart-proctor-backend.onrender.com`).
   - Test it by visiting: `https://smart-proctor-backend.onrender.com/api/health`

---

## Step 2: Deploy Frontends on Vercel

### 1. Deploy Student Portal (`proctor-ui`)
1. Log in to [Vercel Dashboard](https://vercel.com) and click **Add New** > **Project**.
2. Select your repository (`404-brain-not-found`).
3. In project settings:
   - **Project Name:** `smart-proctor-student`
   - **Framework Preset:** `Vite`
   - **Root Directory:** Click Edit and select `proctor-ui`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. Add **Environment Variable**:
   - `VITE_API_URL`: `https://smart-proctor-backend.onrender.com` *(Your Render backend URL)*
5. Click **Deploy**.
6. Note the deployed URL (e.g. `https://smart-proctor-student.vercel.app`).

### 2. Deploy Supervisor Dashboard (`proctor-admin`)
1. In Vercel, click **Add New** > **Project** again.
2. Select the same repository (`404-brain-not-found`).
3. In project settings:
   - **Project Name:** `smart-proctor-admin`
   - **Framework Preset:** `Vite`
   - **Root Directory:** Click Edit and select `proctor-admin`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. Add **Environment Variable**:
   - `VITE_API_URL`: `https://smart-proctor-backend.onrender.com` *(Your Render backend URL)*
5. Click **Deploy**.
6. Note the deployed URL (e.g. `https://smart-proctor-admin.vercel.app`).

---

## Step 3: Update CORS in Backend

Once your frontends are deployed on Vercel:
1. Go back to [Render](https://dashboard.render.com/) > `smart-proctor-backend` > **Environment**.
2. Update `CORS_ORIGINS` to include your new production Vercel domains:
   ```env
   CORS_ORIGINS=https://smart-proctor-student.vercel.app,https://smart-proctor-admin.vercel.app
   ```
3. Save changes. Render will automatically redeploy the backend with the new origins.

---

## Step 4: Build Distributable Electron App (`.exe`)

To package the Electron Secure Examination Browser for students:
1. In your project root, build the student UI bundle pointing to the production API:
   ```bash
   # In proctor-ui/.env.production
   VITE_API_URL=https://smart-proctor-backend.onrender.com
   ```
2. Build the production assets:
   ```bash
   npm run build:student
   ```
3. Run the Electron builder:
   ```bash
   npm run build:electron
   ```
4. Output will be generated in `dist-electron/`:
   - `dist-electron/Smart Proctor Setup 1.0.0.exe` (Windows Installer)
5. Upload this `.exe` to GitHub Releases, Google Drive, or provide a direct download link on the Student Web Portal!

---

## ✅ Deployment Checklist

- [ ] Backend deployed and responding at `/api/health`
- [ ] MongoDB Atlas Network Access allows `0.0.0.0/0` (any IP)
- [ ] Brevo API Key verified for live email OTP delivery
- [ ] Student UI loads tests from Airtable via production backend
- [ ] Admin UI logs in via OTP and displays live verifications
- [ ] Face registration, login verify, and pre-test check working on HTTPS
- [ ] Electron app built and tested
