# ESP32 Realtime Database Integration Guide (Simplified Single-Device Demo)

The simplified PTI Clinic demo connects directly to **Firebase Realtime Database**:
`https://safecrowdai-f5d43-default-rtdb.firebaseio.com`

No Cloud Functions or Blaze billing plan are required.

---

## 1. Realtime Database JSON Structure

### `/device` (Live Status, Heartbeat & Latest Vitals)
The dashboard subscribes to `/device` and combines `status === "online"` with a **60-second `lastSeen` heartbeat timeout**:
```json
{
  "deviceId": "dev_esp32_pti_01",
  "serialNumber": "ESP32-PTI-001",
  "status": "online",
  "lastSeen": 1794997700000,
  "lastSeenIso": "2026-11-18T11:30:00.000Z",
  "batteryPct": 92,
  "heartRateBpm": 82,
  "spo2Pct": 98,
  "surfaceTempC": 36.5
}
```

### `/readings/{readingId}` (Historical Readings for Chart & Table)
```json
{
  "id": "meas_1794997700000",
  "deviceId": "dev_esp32_pti_01",
  "heartRateBpm": 82,
  "spo2Pct": 98,
  "surfaceTempC": 36.5,
  "timestamp": 1794997700000,
  "capturedAt": "2026-11-18T11:30:00.000Z",
  "alertLevel": "normal"
}
```

---

## 2. ESP32 Arduino C++ Sketch Snippet (REST API via `HTTPClient`)

```cpp
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>

const char* FIREBASE_RTDB_URL = "https://safecrowdai-f5d43-default-rtdb.firebaseio.com";

void uploadVitalsToRTDB(int heartRateBpm, int spo2Pct, float surfaceTempC) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure(); // Or client.setCACert(GTS_ROOT_R1_CA)
  HTTPClient http;

  unsigned long long nowMs = (unsigned long long)time(nullptr) * 1000ULL;

  // 1. Update /device (status, lastSeen, and latest 3 parameters)
  String deviceUrl = String(FIREBASE_RTDB_URL) + "/device.json";
  http.begin(client, deviceUrl);
  http.addHeader("Content-Type", "application/json");

  String deviceJson = String("{") +
    "\"deviceId\":\"dev_esp32_pti_01\"," +
    "\"serialNumber\":\"ESP32-PTI-001\"," +
    "\"status\":\"online\"," +
    "\"lastSeen\":" + String(nowMs) + "," +
    "\"batteryPct\":92," +
    "\"heartRateBpm\":" + String(heartRateBpm) + "," +
    "\"spo2Pct\":" + String(spo2Pct) + "," +
    "\"surfaceTempC\":" + String(surfaceTempC, 1) +
  "}";
  http.PUT(deviceJson);
  http.end();

  // 2. Append to /readings/{id} for the dashboard chart & log
  String readingId = "meas_" + String(nowMs);
  String readingUrl = String(FIREBASE_RTDB_URL) + "/readings/" + readingId + ".json";
  http.begin(client, readingUrl);
  http.addHeader("Content-Type", "application/json");

  String readingJson = String("{") +
    "\"id\":\"" + readingId + "\"," +
    "\"deviceId\":\"dev_esp32_pti_01\"," +
    "\"heartRateBpm\":" + String(heartRateBpm) + "," +
    "\"spo2Pct\":" + String(spo2Pct) + "," +
    "\"surfaceTempC\":" + String(surfaceTempC, 1) + "," +
    "\"timestamp\":" + String(nowMs) +
  "}";
  http.PUT(readingJson);
  http.end();
}
```
