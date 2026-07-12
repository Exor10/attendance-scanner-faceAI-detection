/**
 * Face-recognition scan mode.
 *
 * Runs the small CNN trained from scratch in Google Colab
 * (colab/Face_Recognition_Training.ipynb) directly in the browser with
 * TensorFlow.js. When the model is confident it sees the enrolled person for
 * several consecutive frames, it submits a `faceScan` action to the Apps
 * Script backend — same effect as a QR scan, minus the QR card.
 *
 * The first scan of the day (Time In) must still be a QR scan; the backend
 * rejects face-only time-ins by design.
 */
(function (window, document) {
  'use strict';

  const modeQrBtn = document.getElementById('mode-qr-btn');
  const modeFaceBtn = document.getElementById('mode-face-btn');
  if (!modeQrBtn || !modeFaceBtn) return;

  const qrCard = document.getElementById('qr-card');
  const faceCard = document.getElementById('face-card');
  const video = document.getElementById('face-video');
  const statusEl = document.getElementById('face-status');
  const confidenceEl = document.getElementById('face-confidence');
  const cameraSelect = document.getElementById('camera-select');

  const config = (window.APP_CONFIG && window.APP_CONFIG.FACE) || {};
  const modelUrl = config.MODEL_URL || 'model/model.json';
  const employeeId = config.EMPLOYEE_ID || '';
  const inputSize = config.INPUT_SIZE || 96;
  const classNames = config.CLASS_NAMES || ['my_face', 'no_face', 'other_face'];
  const minConfidence = config.MIN_CONFIDENCE || 0.9;
  const requiredMatches = config.CONSECUTIVE_MATCHES || 4;
  const scanIntervalMs = config.SCAN_INTERVAL_MS || 400;
  const cooldownMs = config.COOLDOWN_MS || 6000;
  const deviceName = (window.APP_CONFIG && window.APP_CONFIG.DEVICE_NAME) || 'Face Camera';

  let model = null;
  let stream = null;
  let loopTimer = 0;
  let matchStreak = 0;
  let cooldownUntil = 0;
  let isSubmitting = false;
  let faceModeActive = false;
  let lastSubmitMessage = '';
  let lastSubmitTone = 'status-ok';

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = inputSize;
  cropCanvas.height = inputSize;
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

  function setStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status-line ${type || 'status-warn'}`;
  }

  async function loadModel() {
    if (model) return model;
    if (!window.tf) throw new Error('TensorFlow.js failed to load. Check your connection and refresh.');
    setStatus('Loading face model…', 'status-warn');
    model = await tf.loadLayersModel(modelUrl);
    // Warm-up so the first real prediction is fast.
    tf.tidy(() => model.predict(tf.zeros([1, inputSize, inputSize, 3])));
    return model;
  }

  async function startCamera() {
    const selectedId = (cameraSelect && cameraSelect.value) || '';
    const videoConstraints = selectedId
      ? { deviceId: { exact: selectedId }, width: { ideal: 640 }, height: { ideal: 480 } }
      : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };

    stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    });
    video.srcObject = stream;
    await video.play();
  }

  function stopCamera() {
    if (loopTimer) {
      window.clearTimeout(loopTimer);
      loopTimer = 0;
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
  }

  // Crop the centered square of the video frame (the area under the oval
  // guide) and scale it to the model's input size.
  function grabCenterCrop() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;

    const side = Math.min(vw, vh) * 0.72;
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;
    cropCtx.drawImage(video, sx, sy, side, side, 0, 0, inputSize, inputSize);
    return true;
  }

  function classifyFrame() {
    return tf.tidy(() => {
      const input = tf.browser
        .fromPixels(cropCanvas)
        .toFloat()
        .div(255)
        .expandDims(0);
      const probs = model.predict(input).dataSync();
      let best = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[best]) best = i;
      }
      return { label: classNames[best], confidence: probs[best], probs: Array.from(probs) };
    });
  }

  async function submitFaceScan(confidence) {
    isSubmitting = true;
    setStatus('Face verified — sending scan…', 'status-ok');

    try {
      const data = await window.AppApi.post({
        action: 'faceScan',
        employee_id: employeeId,
        confidence: confidence,
        device: deviceName
      });

      const payload = (data && (data.data || data.record || data.result)) || {};
      lastSubmitMessage = `${data.message || 'Face scan accepted.'} — ${payload.scan_type || ''} ${payload.timestamp || ''}`;
      lastSubmitTone = 'status-ok';
      setStatus(lastSubmitMessage, lastSubmitTone);
    } catch (error) {
      lastSubmitMessage = error.message || 'Face scan was rejected by the server.';
      lastSubmitTone = 'status-error';
      setStatus(lastSubmitMessage, lastSubmitTone);
    } finally {
      isSubmitting = false;
      matchStreak = 0;
      cooldownUntil = Date.now() + cooldownMs;
    }
  }

  async function scanLoop() {
    if (!faceModeActive) return;

    try {
      if (isSubmitting) {
        loopTimer = window.setTimeout(scanLoop, scanIntervalMs);
        return;
      }

      const cooldownRemainingMs = cooldownUntil - Date.now();
      if (cooldownRemainingMs > 0) {
        // Keep showing the last scan result plus a countdown, so it's clear
        // why nothing happens while you're still standing in front of the camera.
        const seconds = Math.ceil(cooldownRemainingMs / 1000);
        setStatus(`${lastSubmitMessage} · Next face scan in ${seconds}s`, lastSubmitTone);
        loopTimer = window.setTimeout(scanLoop, scanIntervalMs);
        return;
      }

      if (grabCenterCrop()) {
        const result = classifyFrame();
        const pct = Math.round(result.confidence * 100);
        confidenceEl.textContent = `${result.label.replace('_', ' ')} — ${pct}%`;

        if (result.label === 'my_face' && result.confidence >= minConfidence) {
          matchStreak += 1;
          setStatus(`Verifying identity… (${matchStreak}/${requiredMatches})`, 'status-warn');
          if (matchStreak >= requiredMatches) {
            await submitFaceScan(result.confidence);
          }
        } else {
          matchStreak = 0;
          if (result.label === 'no_face') {
            setStatus('No face detected. Center your face inside the oval.', 'status-warn');
          } else if (result.label === 'other_face') {
            setStatus('Face not recognized. Only enrolled users can face-scan.', 'status-error');
          } else {
            setStatus('Hold still, improving confidence…', 'status-warn');
          }
        }
      }
    } catch (error) {
      setStatus(error.message || 'Face scanning error.', 'status-error');
    }

    loopTimer = window.setTimeout(scanLoop, scanIntervalMs);
  }

  async function enterFaceMode() {
    if (faceModeActive) return;
    faceModeActive = true;
    matchStreak = 0;

    modeFaceBtn.classList.remove('secondary');
    modeQrBtn.classList.add('secondary');
    qrCard.classList.add('hidden');
    faceCard.classList.remove('hidden');

    if (window.QrScannerControl) {
      await window.QrScannerControl.stop();
    }

    try {
      if (!employeeId) {
        setStatus('Set FACE.EMPLOYEE_ID in js/config.js to your employee ID first.', 'status-error');
        return;
      }
      await loadModel();
      await startCamera();
      setStatus('Face scanner active. Center your face inside the oval.', 'status-ok');
      scanLoop();
    } catch (error) {
      const message = String((error && error.message) || '');
      if (message.toLowerCase().includes('permission') || message.toLowerCase().includes('notallowed')) {
        setStatus('Camera permission denied. Allow camera access and try again.', 'status-error');
      } else if (message.includes('model.json') || message.includes('404') || message.includes('fetch')) {
        setStatus('Face model not found. Train it in Colab and place the files in the /model folder.', 'status-error');
      } else {
        setStatus(message || 'Could not start face scanner.', 'status-error');
      }
    }
  }

  async function enterQrMode() {
    if (!faceModeActive) return;
    faceModeActive = false;

    modeQrBtn.classList.remove('secondary');
    modeFaceBtn.classList.add('secondary');
    faceCard.classList.add('hidden');
    qrCard.classList.remove('hidden');

    stopCamera();
    if (window.QrScannerControl) {
      await window.QrScannerControl.start();
    }
  }

  modeFaceBtn.addEventListener('click', enterFaceMode);
  modeQrBtn.addEventListener('click', enterQrMode);

  if (cameraSelect) {
    cameraSelect.addEventListener('change', async () => {
      if (!faceModeActive) return;
      // Swap only the stream; the scan loop keeps running and simply reads
      // frames from the <video> element once the new stream is playing.
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      matchStreak = 0;
      try {
        await startCamera();
        setStatus('Camera switched. Center your face inside the oval.', 'status-ok');
      } catch (error) {
        setStatus(`Could not switch camera: ${error.message || error}`, 'status-error');
      }
    });
  }

  window.addEventListener('beforeunload', stopCamera);
})(window, document);
