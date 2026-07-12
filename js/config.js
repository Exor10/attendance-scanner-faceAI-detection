(function (window) {
  'use strict';

  window.APP_CONFIG = {
    // Paste the /exec URL of YOUR new Apps Script web app deployment here.
    // See SETUP.md -> "Part 1: Spreadsheet + Apps Script backend".
    API_BASE_URL: 'https://script.google.com/macros/s/AKfycbxeNiLD8xWtSNaDxq3dfIdJlAcftFtqtnTmFomQad4MfwjTc909NdwL9BvG4BkaD_slww/exec',
    DEVICE_NAME: 'Front Desk Webcam',
    LOCAL_SCAN_COOLDOWN_MS: 1800,
    SCAN_PROCESSING_LOCK_MS: 700,
    SCAN_RESULT_RESET_MS: 5000,
    SCANNER_FPS: 15,
    SCANNER_QRBOX_SIZE: 300,
    SCANNER_ASPECT_RATIO: 1.777,
    SCANNER_DISABLE_FLIP: true,
    DASHBOARD_REFRESH_MS: 45000,

    // --- Face recognition (AI check-out) settings ---
    FACE: {
      // Path to the TensorFlow.js model exported from the Colab notebook
      // (colab/Face_Recognition_Training.ipynb). Relative to the site root.
      MODEL_URL: 'model/model.json',
      // Your employee ID (the single test subject of this school project).
      // The backend still requires this person to have QR-timed-in today.
      EMPLOYEE_ID: 'EMP001',
      // Must match the training notebook: input size and class order.
      INPUT_SIZE: 96,
      CLASS_NAMES: ['my_face', 'no_face', 'other_face'],
      // How sure the model must be that it is YOU, per frame (0..1).
      MIN_CONFIDENCE: 0.9,
      // How many confident frames in a row before the scan is submitted.
      CONSECUTIVE_MATCHES: 4,
      // Milliseconds between classified frames.
      SCAN_INTERVAL_MS: 400,
      // Pause after a submission before face scanning resumes, so the scanner
      // doesn't immediately fire again while you are still in front of it.
      COOLDOWN_MS: 15000
    }
  };
})(window);
