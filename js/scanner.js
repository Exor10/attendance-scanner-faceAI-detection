(function (window, document) {
  'use strict';

  const statusEl = document.getElementById('scanner-status');
  if (!statusEl) return;

  const resultName = document.getElementById('result-name');
  const resultScanType = document.getElementById('result-scan-type');
  const resultTime = document.getElementById('result-time');
  const resultStatus = document.getElementById('result-status');
  const resultMessage = document.getElementById('result-message');
  const restartBtn = document.getElementById('restart-btn');
  const soundBtn = document.getElementById('sound-toggle-btn');
  const cameraSelect = document.getElementById('camera-select');
  const clockEl = document.getElementById('clock');
  const flashOverlay = document.getElementById('scan-flash-overlay');

  let flashTimer = 0;

  const config = window.APP_CONFIG || {};
  const cooldownMs = config.LOCAL_SCAN_COOLDOWN_MS || 2500;
  const processingLockMs = config.SCAN_PROCESSING_LOCK_MS || 650;
  const resultResetMs = config.SCAN_RESULT_RESET_MS || 5000;
  const scannerFps = config.SCANNER_FPS || 18;
  const scannerQrboxSize = config.SCANNER_QRBOX_SIZE || 240;
  const scannerAspectRatio = config.SCANNER_ASPECT_RATIO || 1.777;
  const scannerDisableFlip = config.SCANNER_DISABLE_FLIP !== false;
  const deviceName = config.DEVICE_NAME || 'Front Desk Webcam';

  let qrScanner = null;
  let isProcessing = false;
  let isStarting = false;
  let isScannerRunning = false;
  let processingLockUntil = 0;
  let lastToken = '';
  let lastTokenAt = 0;
  let lastCameraId = '';
  let soundOn = true;
  let clearResultTimer = 0;

  function setStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status-line ${type || 'status-warn'}`;
  }

  function setResult({ employee, scanType, timestamp, ok, processing, message }) {
    resultName.textContent = employee || 'Unknown';
    resultScanType.textContent = scanType || '—';
    resultTime.textContent = timestamp || new Date().toLocaleString();
    resultMessage.textContent = message || '—';

    if (processing) {
      resultStatus.textContent = 'Processing';
      resultStatus.className = 'badge warning';
      return;
    }

    resultStatus.textContent = ok ? 'Success' : 'Error';
    resultStatus.className = `badge ${ok ? 'success' : 'danger'}`;
  }

  function resetResultToIdle() {
    setResult({
      employee: '—',
      scanType: '—',
      timestamp: '—',
      ok: true,
      message: 'Ready for next scan.'
    });
    resultStatus.textContent = 'Waiting for scan';
    resultStatus.className = 'badge';
  }

  function scheduleResultReset() {
    if (clearResultTimer) {
      window.clearTimeout(clearResultTimer);
    }

    clearResultTimer = window.setTimeout(() => {
      resetResultToIdle();
    }, resultResetMs);
  }

function pingSound(isSuccess) {
  if (!soundOn || !window.AudioContext) return;

  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'square'; // louder/sharper than sine
  osc.frequency.value = isSuccess ? 1000 : 300;

  // Speaker-friendly volume
  gain.gain.setValueAtTime(0.18, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.22);

  osc.onended = () => ctx.close();
}


  function triggerScanFlash(type) {
    if (!flashOverlay) return;

    const flashClass = type === 'success' ? 'flash-success' : 'flash-error';
    flashOverlay.classList.remove('flash-success', 'flash-error');

    if (flashTimer) {
      window.clearTimeout(flashTimer);
      flashTimer = 0;
    }

    flashOverlay.classList.add(flashClass);
    flashOverlay.classList.remove('flash-active');
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add('flash-active');

    flashTimer = window.setTimeout(() => {
      flashOverlay.classList.remove('flash-active');
    }, 400);
  }

  function canProcessToken(decodedText) {
    const now = Date.now();
    if (!decodedText) return false;
    if (isProcessing || now < processingLockUntil) return false;

    if (decodedText === lastToken && now - lastTokenAt < cooldownMs) {
      setStatus('Same QR recently scanned. Waiting for short cooldown...', 'status-warn');
      return false;
    }

    return true;
  }

  async function handleScan(decodedText) {
    if (!canProcessToken(decodedText)) return;

    isProcessing = true;
    lastToken = decodedText;
    lastTokenAt = Date.now();

    setStatus('QR detected…', 'status-ok');
    setResult({ processing: true, message: 'Processing request...' });

    try {
      const data = await window.AppApi.post({
        action: 'scan',
        qr_token: decodedText,
        device: deviceName
      });

     const payload = data?.data || data?.record || data?.result || {};

setResult({
  employee: payload.full_name || payload.employee_name || payload.employee || payload.employee_id,
  scanType: payload.scan_type || payload.step || data?.scan_type,
  timestamp:
    payload.timestamp ||
    data?.timestamp ||
    payload.datetime ||
    payload.date_time ||
    '',
  ok: true,
  message: data.message || 'Scan accepted.'
});

      pingSound(true);
      triggerScanFlash('success');
      setStatus('Scan complete. Ready shortly...', 'status-ok');
      processingLockUntil = Date.now() + processingLockMs;
      scheduleResultReset();
    } catch (error) {
      setResult({ ok: false, message: error.message || 'Could not send scan.' });
      pingSound(false);
      triggerScanFlash('error');
      setStatus('Scan failed. Retry after checking network/camera.', 'status-error');
      processingLockUntil = Date.now() + 550;
      scheduleResultReset();
    } finally {
      isProcessing = false;
    }
  }

  function handleScanError() {
    // Keep decode errors silent to avoid UI jitter.
  }

  function populateCameraSelect(cameras) {
    if (!cameraSelect) return;
    const previous = cameraSelect.value;
    while (cameraSelect.options.length > 1) cameraSelect.remove(1); // keep "Auto (default)"

    cameras.forEach((camera, index) => {
      const option = document.createElement('option');
      option.value = camera.id;
      option.textContent = camera.label || `Camera ${index + 1}`;
      cameraSelect.appendChild(option);
    });

    if (previous && cameras.some((camera) => camera.id === previous)) {
      cameraSelect.value = previous;
    }
  }

  function chooseCamera(cameras) {
    if (!Array.isArray(cameras) || !cameras.length) return null;

    const byMatch = cameras.find((camera) => {
      const label = String(camera.label || '').toLowerCase();
      return label.includes('back') || label.includes('rear') || label.includes('environment');
    });

    return byMatch || cameras[0];
  }

  async function stopScannerSafe() {
    if (!qrScanner) return;

    try {
      if (isScannerRunning) await qrScanner.stop();
    } catch (_stopError) {}

    try {
      await qrScanner.clear();
    } catch (_clearError) {}

    isScannerRunning = false;
  }

  async function startScanner() {
    if (isStarting) return;
    isStarting = true;
    restartBtn.disabled = true;

    try {
      if (!window.Html5Qrcode) {
        setStatus('Scanner library failed to load. Refresh this page and try again.', 'status-error');
        return;
      }

      await stopScannerSafe();
      qrScanner = new Html5Qrcode('reader');

      setStatus('Checking camera availability...', 'status-warn');
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || !cameras.length) {
        setStatus('No camera detected. Connect a webcam and click Restart Scanner.', 'status-error');
        return;
      }

      populateCameraSelect(cameras);

      const selectedId = (cameraSelect && cameraSelect.value) || '';
      const preferred =
        cameras.find((camera) => camera.id === selectedId) ||
        cameras.find((camera) => camera.id === lastCameraId) ||
        chooseCamera(cameras);
      if (!preferred) {
        setStatus('Unable to choose a camera. Please restart scanner.', 'status-error');
        return;
      }

      lastCameraId = preferred.id;
      setStatus(`Starting camera: ${preferred.label || 'Default Camera'}...`, 'status-warn');

      await qrScanner.start(
        preferred.id,
        {
          fps: scannerFps,
          qrbox: { width: scannerQrboxSize, height: scannerQrboxSize },
          aspectRatio: scannerAspectRatio,
          disableFlip: scannerDisableFlip
        },
        handleScan,
        handleScanError
      );

      isScannerRunning = true;
      setStatus(`Scanner active (${scannerFps} fps). Ready for QR scans.`, 'status-ok');
    } catch (error) {
      const message = String((error && error.message) || '').toLowerCase();
      if (message.includes('permission') || message.includes('notallowed')) {
        setStatus('Camera permission denied. Allow camera access and click Restart Scanner.', 'status-error');
      } else if (message.includes('notfound') || message.includes('overconstrained')) {
        setStatus('Camera could not be started. Reconnect webcam and restart scanner.', 'status-error');
      } else {
        setStatus('Unable to initialize scanner. Refresh or restart scanner.', 'status-error');
      }
      isScannerRunning = false;
    } finally {
      isStarting = false;
      restartBtn.disabled = false;
    }
  }

  restartBtn.addEventListener('click', () => {
    if (!isStarting) {
      setStatus('Restarting scanner...', 'status-warn');
      startScanner();
    }
  });

  if (cameraSelect) {
    cameraSelect.addEventListener('change', () => {
      lastCameraId = cameraSelect.value; // '' = Auto, falls back to chooseCamera
      // Only restart here if the QR scanner is the active mode; face.js
      // listens for the same event and handles Face Mode itself.
      if (isScannerRunning && !isStarting) {
        setStatus('Switching camera...', 'status-warn');
        startScanner();
      }
    });
  }

  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    soundBtn.textContent = `Sound: ${soundOn ? 'On' : 'Off'}`;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  });

  window.setInterval(() => {
    if (clockEl) clockEl.textContent = `Local Time: ${new Date().toLocaleString()}`;
  }, 1000);

  // Allow face.js (Face Mode) to pause/resume the QR scanner when switching modes.
  window.QrScannerControl = {
    start: startScanner,
    stop: stopScannerSafe
  };

  resetResultToIdle();
  startScanner();
})(window, document);
