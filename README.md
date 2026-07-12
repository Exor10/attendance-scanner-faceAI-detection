# Employee Attendance Scanner (Static Frontend + AI Face Recognition)

A static frontend for a QR Attendance and Timekeeping System backed by Google
Apps Script + Google Sheets, deployable directly to GitHub Pages — now with an
**AI face-recognition mode** so the second scan of the day doesn't need a QR
card.

> **New here? Follow [SETUP.md](SETUP.md)** — it walks through creating the
> spreadsheet, deploying the Apps Script backend
> ([google-apps-script/Code.gs](google-apps-script/Code.gs)), and training the
> face model in Google Colab
> ([colab/Face_Recognition_Training.ipynb](colab/Face_Recognition_Training.ipynb)).

## Overview

This project includes:
- **QR Scanner page** using webcam input (via CDN QR library)
- **Face Mode (AI)** on the scanner page: a CNN trained from scratch in Google
  Colab and run in the browser with TensorFlow.js verifies the enrolled
  person's face and submits break/time-out scans without a QR card (time-in
  always requires QR)
- **Dashboard page** for today's attendance records and live refresh
- **Reports page** for per-employee summaries with CSV export and print support
- Shared, reusable **API utility** and **configuration** layer
- **Complete Apps Script backend** (`google-apps-script/Code.gs`) that
  auto-creates and manages the Google Spreadsheet tabs

Backend base is by using Google Apps Script



## File structure

```text
.
├── index.html
├── scanner.html            # QR Mode + Face Mode (AI)
├── dashboard.html
├── reports.html
├── employee-admin.html
├── login.html
├── css/
│   └── styles.css
├── js/
│   ├── config.js           # API URL + face-recognition settings
│   ├── api.js
│   ├── auth.js
│   ├── scanner.js
│   ├── face.js             # in-browser TensorFlow.js face verification
│   ├── dashboard.js
│   ├── employee-admin.js
│   └── reports.js
├── model/                  # trained TF.js face model goes here (see model/README.md)
├── colab/
│   └── Face_Recognition_Training.ipynb   # trains the face CNN from scratch
├── google-apps-script/
│   └── Code.gs             # full backend — paste into your spreadsheet's Apps Script
├── SETUP.md                # step-by-step setup guide
└── README.md
```

## Why `html5-qrcode` (CDN)

The scanner uses `html5-qrcode` from CDN because it is:
- lightweight and mature for static frontends
- easy to integrate without a build process
- compatible with webcam-based scanning workflows

## Deployment to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Repo Settings → Pages**.
3. Set source to your branch (for example `main`) and root (`/`).
4. Save, then open your published GitHub Pages URL.

No additional build step is required.

## Backend URL configuration

Edit `js/config.js` and update `API_BASE_URL` if backend URL changes.

Optional config values there:
- `DEVICE_NAME`
- `LOCAL_SCAN_COOLDOWN_MS`
- `DASHBOARD_REFRESH_MS`

## Notes / known limitations

- Camera access requires HTTPS (GitHub Pages provides HTTPS).
- Browser camera permission must be granted for scanner usage.
- Actual response payload keys from Apps Script may vary; frontend includes defensive fallback mapping.
- Browser autoplay policies may affect scan feedback sounds until user interacts with the page.
