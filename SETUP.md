# Setup Guide — New Spreadsheet, Apps Script Backend, and AI Face Feature

Three parts, in order. Part 1 and 2 take about 10 minutes; Part 3 is the
Colab training session (~30–45 minutes including dataset capture).

---

## Part 1 — New Google Spreadsheet + Apps Script backend

The backend code lives in [`google-apps-script/Code.gs`](google-apps-script/Code.gs).
It is **container-bound**: pasting it into a script attached to your new
spreadsheet is what "connects" it — the code reads/writes that spreadsheet via
`SpreadsheetApp.getActiveSpreadsheet()`, no spreadsheet ID needed.

1. Go to **[sheets.new](https://sheets.new)** and name the spreadsheet, e.g.
   `Attendance System DB`.
2. In the spreadsheet: **Extensions → Apps Script**.
3. Delete the default contents of `Code.gs` and paste in the entire contents of
   `google-apps-script/Code.gs` from this repo. Save (Ctrl+S).
4. In the toolbar function dropdown pick **`setup`** and click **Run**.
   Google will ask for authorization the first time — review and allow.
   This creates two tabs in your spreadsheet:
   - **Employees** — `Employee ID | Full Name | Department | Status | QR Token | QR Image URL | Date Added`
   - **Attendance** — `Date | Employee ID | Full Name | Time In | Break Out | Break In | Time Out | Total Hours | Status | Remarks`
5. **Deploy → New deployment → ⚙ Select type: Web app**
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (ends in `/exec`).
6. Paste that URL into [`js/config.js`](js/config.js) as `API_BASE_URL`.

> Redeploying later? Use **Deploy → Manage deployments → Edit → New version**
> so the URL stays the same.

### Quick test

Open `YOUR_WEB_APP_URL?action=ping` in a browser — you should see
`{"success":true,"message":"Backend is alive."}`.

### Admin password

Default is `admin123` (used by `login.html`). Change it in the Apps Script
editor: **Project Settings → Script properties → ADMIN_PASSWORD**, or edit and
run the `setAdminPassword` function once.

### Register yourself

1. Serve the site locally (`python -m http.server 8000` in the repo folder,
   then open `http://localhost:8000`) or push to GitHub Pages.
2. Open **employee-admin.html**, log in, and add yourself
   (e.g. ID `EMP001`, your name, department, Active).
   A QR token and QR image URL are generated automatically.
3. Click **View QR** and keep the QR on your phone (or print it).
4. Test: open **scanner.html** and scan your QR → the Attendance tab of your
   spreadsheet gets a Time In row.

### Backend behavior (matches the frontend's expectations)

- Scan cycle per day: **Time In → Break Out → Break In → Time Out**
  (set `USE_BREAKS: false` in `Code.gs` for a simple In → Out cycle).
- Scans after `WORK_START` (default 09:00) are marked **Late**.
- Total hours = (Time Out − Time In) − break duration.

---

## Part 2 — Deploy the frontend to GitHub Pages

1. Commit and push this repo to GitHub.
2. Repo **Settings → Pages** → Source: `main` branch, root folder.
3. Open the published URL. Camera features require HTTPS — GitHub Pages
   provides it.

---

## Part 3 — The AI face feature

Goal: after your morning QR scan, **you never need the QR card again that
day** — breaks and time-out are done by looking at the camera.

1. Upload [`colab/Face_Recognition_Training.ipynb`](colab/Face_Recognition_Training.ipynb)
   to [Google Colab](https://colab.research.google.com) (File → Upload notebook).
2. Run the cells top to bottom. You will:
   - capture ~200–300 photos of your face with the Colab webcam widget,
   - capture ~150 "empty room" photos,
   - pull ~600 stranger faces from the public LFW dataset,
   - train a small CNN **from scratch** (3 classes: `my_face`, `no_face`,
     `other_face`),
   - check the confusion matrix and a live webcam test,
   - export to TensorFlow.js and download `face_model_tfjs.zip`.
3. Extract the zip's files into this repo's [`model/`](model) folder
   (`model/model.json` + `group1-shard*.bin`).
4. In `js/config.js` set `FACE.EMPLOYEE_ID` to your employee ID from Part 1.
5. Commit + push. Open **scanner.html → Face Mode (AI)** and look at the
   camera.

### How the connection works (for your project write-up)

- **Training** happens once, in Colab. **Inference** happens in the visitor's
  browser: TensorFlow.js downloads the model files from your GitHub Pages site
  like any other static asset and runs them on the webcam feed locally. No
  image ever leaves the browser; Colab is not involved at runtime.
- When the model sees `my_face` at ≥ 90% confidence for 4 consecutive frames,
  `js/face.js` sends `{action: "faceScan", employee_id, confidence}` to the
  same Apps Script URL the QR scanner uses, and the backend writes the next
  attendance step into the Google Spreadsheet.
- **Safety rule:** the backend refuses a face-scan Time In. The first scan of
  the day must be QR — the face only replaces the *second* (and third/fourth)
  scan, which is exactly the feature goal. It also means a photo of your face
  can't be used to fake a full day from scratch.

### Tuning

| Symptom | Fix |
|---|---|
| "Face not recognized" even though it's you | Lower `FACE.MIN_CONFIDENCE` to 0.8, or retrain with more/better-lit photos |
| Recognizes other people as you | Raise `MIN_CONFIDENCE` to 0.95 and add more LFW images / photos of classmates (with permission) to `other_face` |
| Too slow to trigger | Lower `FACE.CONSECUTIVE_MATCHES` to 3 |
| Flickers between classes | Improve lighting; keep your face filling the oval |
