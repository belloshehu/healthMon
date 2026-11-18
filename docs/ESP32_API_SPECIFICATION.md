# ESP32-WROOM-32 API Specification & Firmware Integration Guide

This document defines the HTTP/REST API contracts between the custom **ESP32-WROOM-32** health monitoring unit (equipped with **MAX30102**, **MLX90614**, **128×64 graphical LCD**, **4×4 matrix keypad**, and **NEXT / CAPTURE / UPLOAD** hardware buttons) and the **HealthOS Firebase Cloud Functions v2** backend.

---

## 1. Security & Authentication Model

### Why Anonymous Firebase Auth Alone Is Not Trusted
The existing Arduino C++ firmware signs in using Firebase Anonymous Authentication. **Anonymous sign-in alone is never treated as proof that a hardware unit is an authorized hospital monitor.** Any internet client with the public Firebase Web API key could call `signInAnonymously`.

To authenticate a trusted ESP32 hardware unit, every request to the backend must include **three headers**:

| Header | Description | Example |
| :--- | :--- | :--- |
| `Authorization` | `Bearer <Firebase_ID_Token>` obtained from Firebase Auth REST API (`identitytoolkit.googleapis.com/v1/accounts:signUp?key=...`). | `Bearer eyJhbGciOiJSUzI1NiIs...` |
| `X-Device-Id` | Provisioned internal device identifier assigned during hospital registration. | `dev_esp32_lag_01` |
| `X-Device-Secret` | 32-byte high-entropy secret provisioned once per device and stored in ESP32 NVS (`Preferences`). Verified on the backend via HMAC-SHA256 (`secretKeyHash`). | `esp32_sec_9f8a7b6c5d4e3f2a...` |
| `Content-Type` | Always JSON. | `application/json` |

All connections **must** use `WiFiClientSecure` over TLS 1.2+ verified against the Google Trust Services root CA bundle (`setCACert(GTS_ROOT_R1_CA)` — never `setInsecure()` in production).

---

## 2. Cloud Functions v2 Endpoints

Base URL (Production): `https://<region>-<project-id>.cloudfunctions.net`  
Base URL (Next.js Local Simulator / Proxy): `http://localhost:3000/api/iot`

### 2.1 Verify Patient Keypad Code & Create Measurement Session
Triggered when the healthcare worker enters a 6-digit numeric patient code on the 4×4 matrix keypad and presses the **`NEXT`** button while online.

- **Endpoint**: `POST /verifyPatientCodeAndCreateSession`
- **Request Body**:
```json
{
  "deviceId": "dev_esp32_lag_01",
  "patientCode": "102345",
  "operatorId": "keypad_operator"
}
```
- **Success Response (`201 Created`)**:
```json
{
  "status": "authorized",
  "sessionId": "sess_9f81c2b4e1029a8c",
  "expiresAt": "2026-11-17T18:45:00.000Z",
  "patientDisplay": {
    "patientCode": "102345",
    "initials": "O.A.",
    "ward": "Medical Ward A",
    "bedNumber": "A-12"
  }
}
```
- **128×64 LCD Behavior**: Display `VERIFIED: O.A. (102345)` and `BED: A-12 -> CAPTURE` so the nurse confirms bed/initials before sampling vitals. Note that only privacy-minimized initials and bed number are returned to the LCD screen (never full patient PII).
- **Error Responses**:
  - `401 Unauthorized`: Missing/expired Firebase ID token or missing `X-Device-Secret`.
  - `403 Forbidden` (`DEVICE_INACTIVE_OR_REVOKED`, `INVALID_DEVICE_SECRET`, `DEVICE_ID_MISMATCH`).
  - `404 Not Found` (`PATIENT_CODE_NOT_FOUND`): Code does not exist in the device's assigned `hospitalId`.
  - `400 Bad Request` (`PATIENT_DISCHARGED`): Patient is discharged.

---

### 2.2 Upload Vital Signs Measurement (Online Session)
Triggered when the healthcare worker presses **`CAPTURE`** (sampling MAX30102 and MLX90614) followed by **`UPLOAD`** while holding an active `sessionId`.

- **Endpoint**: `POST /uploadVitalMeasurement`
- **Request Body**:
```json
{
  "measurementId": "meas_dev_esp32_lag_01_1794935100",
  "sessionId": "sess_9f81c2b4e1029a8c",
  "deviceId": "dev_esp32_lag_01",
  "heartRateBpm": 84,
  "spo2Pct": 97,
  "surfaceTempC": 36.4,
  "capturedAt": "2026-11-17T18:31:40.000Z"
}
```
- **Idempotency & Anti-Reassignment Guarantees**:
  - If the ESP32 retries the same `measurementId` with the same `sessionId` (e.g., due to Wi-Fi packet loss before receiving HTTP 201), the backend returns `200 OK` with `"deduplicated": true` without creating a duplicate record.
  - The backend binds the reading to the `patientId` stored inside `measurementSessions/{sessionId}` and **never** accepts a raw `patientId` from the device.
  - Attempting to reuse `measurementId` with a different `sessionId` returns `409 Conflict` (`MEASUREMENT_REASSIGNMENT_FORBIDDEN`).

---

### 2.3 Offline Batch Synchronization
Triggered when the ESP32 reconnects to Wi-Fi or when the operator presses **`UPLOAD`** while pending offline records exist in flash storage.

- **Endpoint**: `POST /syncOfflineMeasurements`
- **Request Body**:
```json
{
  "deviceId": "dev_esp32_lag_01",
  "firmwareVersion": "v2.4.2-esp32-ard",
  "readings": [
    {
      "measurementId": "offline_dev_esp32_lag_01_00042",
      "patientCode": "102345",
      "heartRateBpm": 88,
      "spo2Pct": 96,
      "surfaceTempC": 36.5,
      "capturedAt": "2026-11-17T14:50:10.000Z"
    }
  ]
}
```
- **Success Response (`200 OK`)**:
```json
{
  "deviceId": "dev_esp32_lag_01",
  "acceptedCount": 1,
  "duplicateCount": 0,
  "rejectedCount": 0,
  "results": [
    {
      "measurementId": "offline_dev_esp32_lag_01_00042",
      "patientCode": "102345",
      "status": "accepted_pending",
      "patientId": "pat_lag_901a2b3c4d",
      "message": "Captured offline reading stored as pending_offline awaiting clinical verification"
    }
  ]
}
```
- **Per-Item Status Handling on the ESP32**:
  - `accepted_pending` or `duplicate_ignored`: Safe to dequeue/delete from ESP32 flash storage.
  - `rejected` (e.g. `UNRECOGNIZED_PATIENT_CODE`): Move to an error log file on flash and alert the operator on the 128×64 LCD so a nurse can inspect the code.

---

### 2.4 Complete Measurement Session
- **Endpoint**: `POST /completeMeasurementSession`
- **Request Body**:
```json
{
  "sessionId": "sess_9f81c2b4e1029a8c",
  "deviceId": "dev_esp32_lag_01"
}
```

---

### 2.5 Device Heartbeat Reporting
- **Endpoint**: `POST /reportDeviceHeartbeat`
- **Request Body**:
```json
{
  "deviceId": "dev_esp32_lag_01",
  "firmwareVersion": "v2.4.2-esp32-ard",
  "wifiRssiDbm": -58,
  "batteryPct": 88,
  "pendingOfflineCount": 0
}
```

---

## 3. Required Arduino C++ Firmware Upgrades for a Durable Offline Queue

Because the current ESP32 firmware only buffers a single measurement in volatile SRAM and uses direct Firestore REST calls, implement the following firmware changes to support a persistent multi-reading offline queue and authenticated session workflows:

1. **Provisioning Credentials in NVS (`Preferences.h`)**:
   - Store `deviceId` and `deviceSecret` in a read-only NVS namespace (`prefs.begin("healthos_sec", true)`).
   - Enable ESP32 Flash Encryption in production builds so physical UART readout cannot dump `deviceSecret`.

2. **Durable Ring-Buffer Queue on LittleFS (`LittleFS.h`)**:
   - Mount a LittleFS partition (`/queue.jsonl`) on the 4 MB SPI flash of the ESP32-WROOM-32.
   - Generate deterministic, collision-free `measurementId` strings using:
     ```cpp
     // Combine deviceId + monotonic NVS boot counter + epoch/millis
     snprintf(measId, sizeof(measId), "offline_%s_%lu_%lu", deviceId, bootCounter, unixTimestamp);
     ```
   - When offline and `UPLOAD` is pressed, append a single newline-delimited JSON record to `/queue.jsonl` containing `{measurementId, patientCode, heartRateBpm, spo2Pct, surfaceTempC, capturedAt}` and flush the file descriptor immediately.

3. **RTC Time Synchronization (NTP + DS3231 Fallback)**:
   - Synchronize system time via `configTime(3600, 0, "pool.ntp.org")` whenever Wi-Fi connects so `capturedAt` ISO-8601 timestamps remain accurate during subsequent offline captures.

4. **Safe Batch Retry & Compaction**:
   - Read up to 25 records at a time from `/queue.jsonl` and POST to `/syncOfflineMeasurements`.
   - Remove only records whose `measurementId` returned `status` in `["accepted_pending", "duplicate_ignored"]`. Keep any transient network failures in `/queue.jsonl` for exponential backoff retry.
