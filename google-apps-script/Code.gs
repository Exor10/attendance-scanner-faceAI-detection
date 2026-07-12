/**
 * Employee Attendance Scanner — Google Apps Script backend
 * =========================================================
 * This script is designed to be CONTAINER-BOUND to a Google Spreadsheet:
 * open your new spreadsheet -> Extensions -> Apps Script -> paste this file.
 * It automatically connects to that spreadsheet via SpreadsheetApp.getActive().
 *
 * First-time setup:
 *   1. Run the `setup` function once from the Apps Script editor (grant permissions).
 *   2. Deploy -> New deployment -> Web app -> Execute as: Me, Access: Anyone.
 *   3. Copy the /exec URL into js/config.js -> API_BASE_URL.
 *
 * Supported GET  actions: dashboard, employees, employeeSummary, attendanceByDate, ping
 * Supported POST actions: scan, faceScan, adminLogin, addEmployee,
 *                         regenerateToken, generateTokens, generateQrUrls
 */

var CONFIG = {
  EMPLOYEES_SHEET: 'Employees',
  ATTENDANCE_SHEET: 'Attendance',
  WORK_START: '09:00',      // scans after this time are marked Late
  USE_BREAKS: true,         // true: In -> Break Out -> Break In -> Out. false: In -> Out.
  DEFAULT_ADMIN_PASSWORD: 'admin123' // change via Script Properties -> ADMIN_PASSWORD
};

var EMP_HEADERS = ['Employee ID', 'Full Name', 'Department', 'Status', 'QR Token', 'QR Image URL', 'Date Added'];
var ATT_HEADERS = ['Date', 'Employee ID', 'Full Name', 'Time In', 'Break Out', 'Break In', 'Time Out', 'Total Hours', 'Status', 'Remarks'];

/* ------------------------------------------------------------------ *
 *  Entry points
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    ensureSheets_();
    var action = (e && e.parameter && e.parameter.action) || '';

    switch (action) {
      case 'ping':
        return json_({ success: true, message: 'Backend is alive.' });
      case 'dashboard':
        return json_(getDashboard_());
      case 'employees':
        return json_(getEmployees_());
      case 'employeeSummary':
        return json_(getEmployeeSummary_(e.parameter.employee_id));
      case 'attendanceByDate':
        return json_(getAttendanceByDate_(e.parameter.start_date, e.parameter.end_date));
      default:
        return json_({ success: false, message: 'Unknown GET action: "' + action + '"' });
    }
  } catch (err) {
    return json_({ success: false, message: 'Server error: ' + err.message });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureSheets_();
    var body = {};
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (parseErr) {
      return json_({ success: false, message: 'Invalid JSON body.' });
    }

    switch (body.action) {
      case 'scan':
        return json_(handleScan_(body.qr_token, body.device));
      case 'faceScan':
        return json_(handleFaceScan_(body.employee_id, body.confidence, body.device));
      case 'adminLogin':
        return json_(handleAdminLogin_(body.password));
      case 'addEmployee':
        return json_(addEmployee_(body));
      case 'regenerateToken':
        return json_(regenerateToken_(body.employee_id));
      case 'generateTokens':
        return json_(generateTokens_());
      case 'generateQrUrls':
        return json_(generateQrUrls_());
      default:
        return json_({ success: false, message: 'Unknown POST action: "' + (body.action || '') + '"' });
    }
  } catch (err) {
    return json_({ success: false, message: 'Server error: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 *  Scan handling (QR + Face)
 * ------------------------------------------------------------------ */

function handleScan_(qrToken, device) {
  if (!qrToken) return { success: false, message: 'Missing QR token.' };

  var employee = findEmployeeBy_('QR Token', String(qrToken).trim());
  if (!employee) return { success: false, message: 'QR code not recognized. Ask admin to check your token.' };
  if (String(employee['Status']).toLowerCase() !== 'active') {
    return { success: false, message: 'Employee ' + employee['Employee ID'] + ' is inactive.' };
  }

  return recordScanStep_(employee, device || 'Unknown Device', false);
}

/**
 * Face-recognition scan. Security model for this project:
 * the FIRST scan of the day must be a QR scan (time in). Face scans can only
 * advance an attendance row that already exists for today, so a face alone
 * can never create a time-in.
 */
function handleFaceScan_(employeeId, confidence, device) {
  if (!employeeId) return { success: false, message: 'Missing employee_id for face scan.' };

  var employee = findEmployeeBy_('Employee ID', String(employeeId).trim().toUpperCase());
  if (!employee) return { success: false, message: 'Unknown employee for face scan.' };
  if (String(employee['Status']).toLowerCase() !== 'active') {
    return { success: false, message: 'Employee ' + employee['Employee ID'] + ' is inactive.' };
  }

  var todayRow = findTodayAttendanceRow_(employee['Employee ID']);
  if (!todayRow) {
    return { success: false, message: 'No time-in found today. Please scan your QR code first to time in.' };
  }

  var result = recordScanStep_(employee, device || 'Face Camera', true);
  if (result.success && confidence) {
    result.message += ' (face confidence ' + Math.round(Number(confidence) * 100) + '%)';
  }
  return result;
}

function recordScanStep_(employee, device, viaFace) {
  var sheet = getSheet_(CONFIG.ATTENDANCE_SHEET);
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var timeStr = Utilities.formatDate(now, tz, 'HH:mm:ss');
  var fullTimestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss');
  var suffix = viaFace ? ' (Face)' : '';

  var rowInfo = findTodayAttendanceRow_(employee['Employee ID']);

  // --- First scan of the day: Time In ---
  if (!rowInfo) {
    if (viaFace) return { success: false, message: 'Time in requires a QR scan.' };
    var isLate = timeStr > CONFIG.WORK_START + ':00';
    sheet.appendRow([
      today,
      employee['Employee ID'],
      employee['Full Name'],
      timeStr,
      '', '', '', '',
      isLate ? 'Late' : 'Incomplete',
      (isLate ? 'Late arrival' : 'On time') + ' · Device: ' + device
    ]);
    return scanOk_(employee, 'Time In', fullTimestamp, isLate ? 'Time in recorded (Late).' : 'Time in recorded. Good day!');
  }

  var row = rowInfo.values;
  var rowIndex = rowInfo.rowIndex;
  var wasLate = String(row[8]).toLowerCase().indexOf('late') !== -1 || String(row[9]).toLowerCase().indexOf('late') !== -1;

  function setCell(colIndex, value) {
    sheet.getRange(rowIndex, colIndex + 1).setValue(value);
  }
  function appendRemark(text) {
    var current = String(row[9] || '');
    setCell(9, current ? current + ' · ' + text : text);
  }

  // --- Steps 2..4 depending on break mode ---
  if (CONFIG.USE_BREAKS) {
    if (!row[4]) { // Break Out
      setCell(4, timeStr);
      setCell(8, 'On Break');
      appendRemark('Break out' + suffix);
      return scanOk_(employee, 'Break Out' + suffix, fullTimestamp, 'Break out recorded. Enjoy your break!');
    }
    if (!row[5]) { // Break In
      setCell(5, timeStr);
      setCell(8, wasLate ? 'Late' : 'Incomplete');
      appendRemark('Break in' + suffix);
      return scanOk_(employee, 'Break In' + suffix, fullTimestamp, 'Welcome back from break.');
    }
  }

  if (!row[6]) { // Time Out
    setCell(6, timeStr);
    var totalHours = computeTotalHours_(String(row[3]), String(row[4]), String(row[5]), timeStr);
    setCell(7, totalHours);
    setCell(8, wasLate ? 'Completed (Late)' : 'Completed');
    appendRemark('Time out' + suffix);
    return scanOk_(employee, 'Time Out' + suffix, fullTimestamp, 'Time out recorded. Total: ' + totalHours + ' hrs. See you tomorrow!');
  }

  return { success: false, message: 'Attendance already completed for today.' };
}

function scanOk_(employee, scanType, timestamp, message) {
  return {
    success: true,
    message: message,
    data: {
      employee_id: employee['Employee ID'],
      full_name: employee['Full Name'],
      scan_type: scanType,
      timestamp: timestamp
    }
  };
}

function computeTotalHours_(timeIn, breakOut, breakIn, timeOut) {
  function mins(t) {
    if (!t) return null;
    var parts = String(t).split(':');
    return Number(parts[0]) * 60 + Number(parts[1]) + Number(parts[2] || 0) / 60;
  }
  var start = mins(timeIn);
  var end = mins(timeOut);
  if (start === null || end === null) return '';

  var worked = end - start;
  var bOut = mins(breakOut);
  var bIn = mins(breakIn);
  if (bOut !== null && bIn !== null && bIn > bOut) worked -= (bIn - bOut);
  if (worked < 0) worked = 0;
  return (Math.round((worked / 60) * 100) / 100).toFixed(2);
}

/* ------------------------------------------------------------------ *
 *  Read endpoints
 * ------------------------------------------------------------------ */

function getDashboard_() {
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var records = readAttendance_().filter(function (r) { return r.date === today; });
  return { success: true, records: records };
}

function getEmployeeSummary_(employeeId) {
  if (!employeeId) return { success: false, message: 'Missing employee_id.' };
  var id = String(employeeId).trim().toUpperCase();
  var history = readAttendance_().filter(function (r) {
    return String(r.employee_id).toUpperCase() === id;
  });

  history.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

  var completed = 0, late = 0, totalHours = 0;
  history.forEach(function (r) {
    var s = String(r.status).toLowerCase();
    if (s.indexOf('complete') !== -1 && s.indexOf('incomplete') === -1) completed++;
    if (s.indexOf('late') !== -1) late++;
    totalHours += Number(r.total_hours) || 0;
  });

  return {
    success: true,
    present_days: history.length,
    completed_days: completed,
    late_days: late,
    total_worked_hours: totalHours.toFixed(2),
    history: history
  };
}

function getAttendanceByDate_(startDate, endDate) {
  if (!startDate || !endDate) return { success: false, message: 'Missing start_date or end_date.' };
  var rows = readAttendance_().filter(function (r) {
    return r.date >= startDate && r.date <= endDate;
  });
  rows.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return { success: true, rows: rows };
}

function getEmployees_() {
  var sheet = getSheet_(CONFIG.EMPLOYEES_SHEET);
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    rows.push({
      employee_id: String(values[i][0]),
      full_name: String(values[i][1]),
      department: String(values[i][2]),
      status: String(values[i][3]),
      qr_token: String(values[i][4]),
      qr_image_url: String(values[i][5])
    });
  }
  return { success: true, rows: rows };
}

/* ------------------------------------------------------------------ *
 *  Admin endpoints
 * ------------------------------------------------------------------ */

function handleAdminLogin_(password) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || CONFIG.DEFAULT_ADMIN_PASSWORD;
  if (String(password) !== stored) {
    return { success: false, message: 'Incorrect password.' };
  }
  return { success: true, token: Utilities.getUuid(), message: 'Login successful.' };
}

function addEmployee_(body) {
  var id = String(body.employee_id || '').trim().toUpperCase();
  var name = String(body.full_name || '').trim();
  var dept = String(body.department || '').trim();
  var status = String(body.status || 'Active').trim();

  if (!id || !name || !dept) return { success: false, message: 'Employee ID, Full Name and Department are required.' };
  if (findEmployeeBy_('Employee ID', id)) return { success: false, message: 'Employee ' + id + ' already exists.' };

  var token = newToken_();
  var sheet = getSheet_(CONFIG.EMPLOYEES_SHEET);
  var tz = Session.getScriptTimeZone();
  sheet.appendRow([id, name, dept, status, token, qrImageUrl_(token), Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd')]);
  return { success: true, message: 'Employee ' + id + ' added with QR token.' };
}

function regenerateToken_(employeeId) {
  var id = String(employeeId || '').trim().toUpperCase();
  var sheet = getSheet_(CONFIG.EMPLOYEES_SHEET);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).toUpperCase() === id) {
      var token = newToken_();
      sheet.getRange(i + 1, 5).setValue(token);
      sheet.getRange(i + 1, 6).setValue(qrImageUrl_(token));
      return { success: true, message: 'Token regenerated for ' + id + '.' };
    }
  }
  return { success: false, message: 'Employee ' + id + ' not found.' };
}

function generateTokens_() {
  var sheet = getSheet_(CONFIG.EMPLOYEES_SHEET);
  var values = sheet.getDataRange().getValues();
  var count = 0;
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] && !values[i][4]) {
      var token = newToken_();
      sheet.getRange(i + 1, 5).setValue(token);
      sheet.getRange(i + 1, 6).setValue(qrImageUrl_(token));
      count++;
    }
  }
  return { success: true, message: 'Generated tokens for ' + count + ' employee(s).' };
}

function generateQrUrls_() {
  var sheet = getSheet_(CONFIG.EMPLOYEES_SHEET);
  var values = sheet.getDataRange().getValues();
  var count = 0;
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] && values[i][4] && !values[i][5]) {
      sheet.getRange(i + 1, 6).setValue(qrImageUrl_(String(values[i][4])));
      count++;
    }
  }
  return { success: true, message: 'Generated QR image URLs for ' + count + ' employee(s).' };
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function newToken_() {
  return 'EMP-' + Utilities.getUuid().replace(/-/g, '').slice(0, 20).toUpperCase();
}

function qrImageUrl_(token) {
  return 'https://quickchart.io/qr?size=300&text=' + encodeURIComponent(token);
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run setup() first.');
  return sheet;
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.EMPLOYEES_SHEET) || !ss.getSheetByName(CONFIG.ATTENDANCE_SHEET)) {
    setup();
  }
}

function findEmployeeBy_(headerName, value) {
  var sheet = getSheet_(CONFIG.EMPLOYEES_SHEET);
  var values = sheet.getDataRange().getValues();
  var col = EMP_HEADERS.indexOf(headerName);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][col]) === String(value)) {
      var emp = {};
      EMP_HEADERS.forEach(function (h, idx) { emp[h] = values[i][idx]; });
      return emp;
    }
  }
  return null;
}

function findTodayAttendanceRow_(employeeId) {
  var sheet = getSheet_(CONFIG.ATTENDANCE_SHEET);
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    var rowDate = normalizeDate_(values[i][0], tz);
    if (rowDate === today && String(values[i][1]).toUpperCase() === String(employeeId).toUpperCase()) {
      return {
        rowIndex: i + 1,
        values: values[i].map(function (v, idx) {
          if (idx === 0) return rowDate;
          if (idx >= 3 && idx <= 6) return normalizeTime_(v, tz);
          return v;
        })
      };
    }
  }
  return null;
}

function readAttendance_() {
  var sheet = getSheet_(CONFIG.ATTENDANCE_SHEET);
  var tz = Session.getScriptTimeZone();
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][1]) continue;
    rows.push({
      date: normalizeDate_(values[i][0], tz),
      employee_id: String(values[i][1]),
      full_name: String(values[i][2]),
      time_in: normalizeTime_(values[i][3], tz),
      break_out: normalizeTime_(values[i][4], tz),
      break_in: normalizeTime_(values[i][5], tz),
      time_out: normalizeTime_(values[i][6], tz),
      total_hours: String(values[i][7]),
      status: String(values[i][8]),
      remarks: String(values[i][9])
    });
  }
  return rows;
}

// Sheets may auto-convert "2026-07-12" and "08:15:00" into Date objects; normalize back to strings.
function normalizeDate_(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  return String(value || '');
}

function normalizeTime_(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, 'HH:mm:ss');
  return String(value || '');
}

/* ------------------------------------------------------------------ *
 *  One-time setup — run manually from the editor
 * ------------------------------------------------------------------ */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var emp = ss.getSheetByName(CONFIG.EMPLOYEES_SHEET) || ss.insertSheet(CONFIG.EMPLOYEES_SHEET);
  if (emp.getLastRow() === 0) {
    emp.getRange(1, 1, 1, EMP_HEADERS.length).setValues([EMP_HEADERS]).setFontWeight('bold');
    emp.setFrozenRows(1);
    emp.getRange('A:G').setNumberFormat('@'); // keep IDs/tokens/dates as plain text
    emp.autoResizeColumns(1, EMP_HEADERS.length);
  }

  var att = ss.getSheetByName(CONFIG.ATTENDANCE_SHEET) || ss.insertSheet(CONFIG.ATTENDANCE_SHEET);
  if (att.getLastRow() === 0) {
    att.getRange(1, 1, 1, ATT_HEADERS.length).setValues([ATT_HEADERS]).setFontWeight('bold');
    att.setFrozenRows(1);
    att.getRange('A:J').setNumberFormat('@');
    att.autoResizeColumns(1, ATT_HEADERS.length);
  }

  // Remove the default empty sheet if it exists and is unused
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 2) {
    ss.deleteSheet(defaultSheet);
  }

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_PASSWORD')) {
    props.setProperty('ADMIN_PASSWORD', CONFIG.DEFAULT_ADMIN_PASSWORD);
  }

  Logger.log('Setup complete. Sheets ready: Employees, Attendance. Admin password: ' +
    props.getProperty('ADMIN_PASSWORD') + ' (change it in Project Settings -> Script properties).');
}

/** Optional helper: run once from the editor to change the admin password. */
function setAdminPassword() {
  var NEW_PASSWORD = 'PUT_YOUR_NEW_PASSWORD_HERE';
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', NEW_PASSWORD);
  Logger.log('Admin password updated.');
}
