# ESP32 Firmware & Cloud Firestore Integration Guide (`safecrowdai-f5d43`)

This document describes how the ESP32 Arduino sketch ([firmware/healthos_esp32/healthos_esp32.ino](file:///Users/belloshehu/dev/healthos/firmware/healthos_esp32/healthos_esp32.ino)) and the Next.js Web Dashboard ([src/hooks/useRealtimeVitals.ts](file:///Users/belloshehu/dev/healthos/src/hooks/useRealtimeVitals.ts)) interact via **Cloud Firestore**.

---

## 1. Firestore Document Paths & Fields Used by the ESP32

### 1.1 Vital Measurements Upload (`PIN_UPLOAD`)
When `PIN_UPLOAD` (GPIO 27) is pressed on the ESP32, `uploadReading()` authenticates via **Firebase Anonymous Auth** (`uid`, `idToken`) and sends an `HTTP PATCH` to:
```
https://firestore.googleapis.com/v1/projects/safecrowdai-f5d43/databases/(default)/documents/deviceReadings/{uid}/measurements/{lastUploadId}
```

#### Document Fields
| Field | Firestore Type | Description |
| :--- | :--- | :--- |
| `deviceId` | `stringValue` | `"dev_esp32_pti_01"` |
| `anonymousUid` | `stringValue` | ESP32's Firebase Anonymous Auth `uid` |
| `measurementType` | `stringValue` | `"prototype"` |
| `uploadedBy` | `stringValue` | `"esp32"` |
| `heartRate` | `integerValue` | Optional (included when `reading.hrValid == true`, `40..200` BPM) |
| `heartRateEpoch` | `integerValue` | Optional Unix timestamp in **seconds** when HR was captured |
| `spo2` | `integerValue` | Optional (included when `reading.spo2Valid == true`, `70..100` %) |
| `spo2Epoch` | `integerValue` | Optional Unix timestamp in **seconds** when $\text{SpO}_2$ was captured |
| `temperatureC` | `doubleValue` | Optional (included when `reading.tempValid == true`, MLX90614 surface °C) |
| `temperatureEpoch` | `integerValue` | Optional Unix timestamp in **seconds** when temp was captured |

### 1.2 Device Online/Offline Status & Heartbeat
- Every upload from the ESP32 automatically marks the device **Online** on the web dashboard.
- In addition, [healthos_esp32.ino](file:///Users/belloshehu/dev/healthos/firmware/healthos_esp32/healthos_esp32.ino) includes a non-blocking `sendHeartbeat()` every 30 seconds that sends an `HTTP PATCH` to:
  ```
  https://firestore.googleapis.com/v1/projects/safecrowdai-f5d43/databases/(default)/documents/devices/dev_esp32_pti_01
  ```
  with `{ deviceId: "dev_esp32_pti_01", anonymousUid: uid, status: "online", lastSeenEpoch: epochNow() }`.
- If no upload or heartbeat is received within **60 seconds**, the web dashboard automatically transitions the status badge to **`Device Offline (>60s)`**.

---

## 2. Firmware Bug Fixed in `healthos_esp32.ino`

In `setup()`, the original sketch had a duplicate declaration that shadowed the global `bool mlxReady`:
```cpp
// BEFORE (Bug: local `bool mlxReady` shadowed global `mlxReady`)
mlxReady = mlx.begin(0x5A, &Wire);
bool mlxReady = false;
mlxReady = mlx.begin(0x5A, &Wire);

// AFTER (Fixed in firmware/healthos_esp32/healthos_esp32.ino)
mlxReady = mlx.begin(0x5A, &Wire);
```

---

## 3. Deploying Firestore Rules & Indexes to `safecrowdai-f5d43`

Before uploading from the ESP32 or opening the dashboard, deploy the aligned Firestore rules and `measurements` collection-group index:
```bash
npx -y firebase-tools@latest deploy --only firestore:rules,firestore:indexes
```
