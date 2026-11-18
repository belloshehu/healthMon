#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <U8g2lib.h>
#include <Adafruit_MLX90614.h>
#include <MAX30105.h>
#include "spo2_algorithm.h"
#include <time.h>

// ===== USER CONFIGURATION =====
const char* WIFI_SSID = "MTN_4G_854DDB";
const char* WIFI_PASSWORD = "Sfulani@";
const char* FIREBASE_API_KEY = "AIzaSyCyANuP3SgrjeAgl_GYf2tgMJYgo1ZVVZ8";
const char* FIREBASE_PROJECT_ID = "safecrowdai-f5d43";
const char* DEVICE_ID = "dev_esp32_pti_01";
// WARNING: Prototype only. Replace setInsecure() with certificate validation before real deployment.

constexpr uint8_t PIN_SDA = 21, PIN_SCL = 22;
constexpr uint8_t PIN_NEXT = 25, PIN_CAPTURE = 26, PIN_UPLOAD = 27;
constexpr uint8_t MAX_SAMPLES = 100;
constexpr uint32_t DEBOUNCE_MS = 45;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 30000UL; // 30-second online status heartbeat

// Initialize U8g2 for the ST7567S display
constexpr uint8_t LCD_SCL = 18;
constexpr uint8_t LCD_SDA = 19;

U8G2_ST7567_ENH_DG128064I_F_SW_I2C display(
  U8G2_R0,
  LCD_SCL,
  LCD_SDA,
  U8X8_PIN_NONE
);

Adafruit_MLX90614 mlx;
MAX30105 max30102;
bool maxReady = false;
bool mlxReady = false;
Preferences prefs;

enum Page : uint8_t { PAGE_HR, PAGE_SPO2, PAGE_TEMP, PAGE_REVIEW };
Page page = PAGE_HR;
struct Reading {
  bool hrValid = false, spo2Valid = false, tempValid = false;
  int32_t heartRate = 0, spo2 = 0;
  float temperatureC = NAN;
  uint32_t capturedHrAt = 0, capturedSpo2At = 0, capturedTempAt = 0;
} reading;

struct Button {
  uint8_t pin;
  bool stable = HIGH, lastRaw = HIGH;
  uint32_t changedAt = 0;
  bool pressed() {
    bool raw = digitalRead(pin);
    if (raw != lastRaw) { lastRaw = raw; changedAt = millis(); }
    if (millis() - changedAt >= DEBOUNCE_MS && raw != stable) {
      stable = raw;
      return stable == LOW;
    }
    return false;
  }
};
Button btnNext{PIN_NEXT}, btnCapture{PIN_CAPTURE}, btnUpload{PIN_UPLOAD};

String uid, idToken, refreshToken;
uint32_t tokenIssuedAt = 0;
uint32_t tokenExpiresSec = 0;
uint32_t lastHeartbeatAt = 0;
String statusLine = "Starting...";
String lastUploadId;

void displayInit() {
  display.setI2CAddress(0x3F * 2);
  display.begin();
  display.clearBuffer();
  display.setFont(u8g2_font_ncenB08_tr);
}

void drawScreen() {
  display.clearBuffer();
  display.setFont(u8g2_font_6x12_tf);
  display.drawStr(0, 11, "IoT HEALTH MONITOR");
  display.drawHLine(0, 14, 128);
  char line[35];
  if (page == PAGE_HR) {
    display.drawStr(0, 28, "HEART RATE");
    if (reading.hrValid) { snprintf(line, sizeof(line), "%ld BPM", (long)reading.heartRate); display.drawStr(0, 43, line); }
    else display.drawStr(0, 43, "Not captured");
  } else if (page == PAGE_SPO2) {
    display.drawStr(0, 28, "BLOOD OXYGEN");
    if (reading.spo2Valid) { snprintf(line, sizeof(line), "%ld %%", (long)reading.spo2); display.drawStr(0, 43, line); }
    else display.drawStr(0, 43, "Not captured");
  } else if (page == PAGE_TEMP) {
    display.drawStr(0, 28, "SURFACE TEMP");
    if (reading.tempValid) { snprintf(line, sizeof(line), "%.1f C", reading.temperatureC); display.drawStr(0, 43, line); }
    else display.drawStr(0, 43, "Not captured");
  } else {
    snprintf(line, sizeof(line), "HR:%s  SpO2:%s", reading.hrValid ? String(reading.heartRate).c_str() : "--", reading.spo2Valid ? String(reading.spo2).c_str() : "--");
    display.drawStr(0, 28, line);
    if (reading.tempValid) snprintf(line, sizeof(line), "Temp: %.1f C", reading.temperatureC);
    else snprintf(line, sizeof(line), "Temp: --");
    display.drawStr(0, 43, line);
  }
  display.drawHLine(0, 47, 128);
  display.setFont(u8g2_font_5x8_tf);
  display.drawUTF8(0, 58, statusLine.substring(0, 25).c_str());
  display.sendBuffer();
}
void setStatus(const String& s) { statusLine = s; Serial.println(s); drawScreen(); }

uint32_t epochNow() {
  time_t now = time(nullptr);
  return now > 1700000000 ? (uint32_t)now : 0;
}

void saveReading() {
  prefs.putBool("hrv", reading.hrValid);
  prefs.putBool("spv", reading.spo2Valid);
  prefs.putBool("tv", reading.tempValid);
  prefs.putInt("hr", reading.heartRate);
  prefs.putInt("sp", reading.spo2);
  prefs.putFloat("tc", reading.temperatureC);
  prefs.putUInt("hrt", reading.capturedHrAt);
  prefs.putUInt("spt", reading.capturedSpo2At);
  prefs.putUInt("tt", reading.capturedTempAt);
}
void loadReading() {
  reading.hrValid = prefs.getBool("hrv", false);
  reading.spo2Valid = prefs.getBool("spv", false);
  reading.tempValid = prefs.getBool("tv", false);
  reading.heartRate = prefs.getInt("hr", 0);
  reading.spo2 = prefs.getInt("sp", 0);
  reading.temperatureC = prefs.getFloat("tc", NAN);
  reading.capturedHrAt = prefs.getUInt("hrt", 0);
  reading.capturedSpo2At = prefs.getUInt("spt", 0);
  reading.capturedTempAt = prefs.getUInt("tt", 0);
}
void clearReading() { reading = Reading(); saveReading(); }

bool postJson(const String& url, const String& json, String& response, int& code, const String& bearer = "") {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) return false;
  http.setTimeout(12000);
  http.addHeader("Content-Type", "application/json");
  if (bearer.length()) http.addHeader("Authorization", "Bearer " + bearer);
  code = http.POST(json);
  response = http.getString();
  http.end();
  return code > 0;
}

bool parseAuth(const String& payload, bool refresh) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  const char* tok = doc["idToken"] | "";
  const char* ref = doc["refreshToken"] | "";
  const char* user = refresh ? (doc["user_id"] | "") : (doc["localId"] | "");
  if (!strlen(tok) || !strlen(ref)) return false;
  idToken = tok;
  refreshToken = ref;
  if (strlen(user)) uid = user;
  const char* exp = doc["expiresIn"] | "3600";
  tokenExpiresSec = (uint32_t)atol(exp);
  tokenIssuedAt = millis();
  prefs.putString("refresh", refreshToken);
  prefs.putString("uid", uid);
  return true;
}

bool refreshAuth() {
  if (refreshToken.isEmpty()) return false;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String("https://securetoken.googleapis.com/v1/token?key=") + FIREBASE_API_KEY;
  if (!http.begin(client, url)) return false;
  http.setTimeout(12000);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  String body = "grant_type=refresh_token&refresh_token=" + refreshToken;
  int code = http.POST(body);
  String response = http.getString();
  http.end();
  if (code != 200) { Serial.printf("Token refresh failed: HTTP %d\n", code); return false; }
  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  const char* tok = doc["id_token"] | "";
  const char* ref = doc["refresh_token"] | "";
  const char* user = doc["user_id"] | "";
  if (!strlen(tok) || !strlen(ref)) return false;
  idToken = tok;
  refreshToken = ref;
  uid = user;
  const char* exp = doc["expires_in"] | "3600";
  tokenExpiresSec = (uint32_t)atol(exp);
  tokenIssuedAt = millis();
  prefs.putString("refresh", refreshToken);
  prefs.putString("uid", uid);
  return true;
}

bool signInAnonymously() {
  String response;
  int code = 0;
  String url = String("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=") + FIREBASE_API_KEY;
  if (!postJson(url, "{\"returnSecureToken\":true}", response, code)) return false;
  if (code != 200) { Serial.printf("Anonymous sign-in failed: HTTP %d: %s\n", code, response.c_str()); return false; }
  return parseAuth(response, false);
}

bool ensureAuth() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!idToken.isEmpty() && tokenExpiresSec > 120 && (uint32_t)(millis() - tokenIssuedAt) < (tokenExpiresSec - 120) * 1000UL) return true;
  if (refreshAuth()) return true;
  return signInAnonymously();
}

void addIntField(JsonObject fields, const char* key, int32_t value) {
  fields[key]["integerValue"] = String(value);
}
void addDoubleField(JsonObject fields, const char* key, double value) {
  fields[key]["doubleValue"] = value;
}
void addStringField(JsonObject fields, const char* key, const String& value) {
  fields[key]["stringValue"] = value;
}

// Lightweight 30-second heartbeat so the web dashboard shows live Online/Offline status
bool sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!ensureAuth()) return false;
  uint32_t nowSec = epochNow();
  JsonDocument doc;
  JsonObject fields = doc["fields"].to<JsonObject>();
  addStringField(fields, "deviceId", DEVICE_ID);
  addStringField(fields, "anonymousUid", uid);
  addStringField(fields, "status", "online");
  if (nowSec > 0) addIntField(fields, "lastSeenEpoch", nowSec);
  String payload;
  serializeJson(doc, payload);

  String url = String("https://firestore.googleapis.com/v1/projects/") + FIREBASE_PROJECT_ID + "/databases/(default)/documents/devices/" + DEVICE_ID;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) return false;
  http.setTimeout(8000);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest("PATCH", payload);
  http.end();
  return code == 200;
}

bool capturePulse() {
  if (!maxReady) { setStatus("MAX not initialized"); return false; }
  setStatus("Hold finger steady");
  uint32_t ir[MAX_SAMPLES] = {0}, red[MAX_SAMPLES] = {0};

  max30102.clearFIFO();
  const uint32_t totalStart = millis();
  uint32_t lastSampleAt = millis();
  int count = 0;
  while (count < MAX_SAMPLES) {
    max30102.check();
    while (max30102.available() && count < MAX_SAMPLES) {
      red[count] = max30102.getRed();
      ir[count] = max30102.getIR();
      max30102.nextSample();
      lastSampleAt = millis();
      count++;
    }
    if (millis() - lastSampleAt > 3000UL ||
        millis() - totalStart > 20000UL) {
      Serial.printf("MAX timeout: collected %d/%d samples\n", count, MAX_SAMPLES);
      setStatus("MAX sample timeout");
      return false;
    }
    delay(5);
  }

  uint32_t minIR = UINT32_MAX, maxIR = 0;
  uint64_t sumIR = 0;
  for (int i = 0; i < MAX_SAMPLES; ++i) {
    if (ir[i] < minIR) minIR = ir[i];
    if (ir[i] > maxIR) maxIR = ir[i];
    sumIR += ir[i];
  }
  Serial.printf("MAX IR min=%lu max=%lu avg=%lu\n",
                (unsigned long)minIR, (unsigned long)maxIR,
                (unsigned long)(sumIR / MAX_SAMPLES));
  if (sumIR / MAX_SAMPLES < 1000UL) {
    setStatus("Place finger on MAX");
    return false;
  }

  int32_t sp = 0, hr = 0;
  int8_t spValid = 0, hrValid = 0;
  maxim_heart_rate_and_oxygen_saturation(ir, MAX_SAMPLES, red,
                                          &sp, &spValid, &hr, &hrValid);
  Serial.printf("Algorithm: HR=%ld valid=%d SpO2=%ld valid=%d\n",
                (long)hr, hrValid, (long)sp, spValid);
  reading.hrValid = (hrValid != 0 && hr >= 40 && hr <= 200);
  reading.spo2Valid = (spValid != 0 && sp >= 70 && sp <= 100);
  if (reading.hrValid) {
    reading.heartRate = hr;
    reading.capturedHrAt = epochNow();
  }
  if (reading.spo2Valid) {
    reading.spo2 = sp;
    reading.capturedSpo2At = epochNow();
  }
  saveReading();
  if (!reading.hrValid && !reading.spo2Valid) {
    setStatus("Invalid pulse data");
    return false;
  }
  setStatus("Pulse saved");
  return true;
}

bool captureTemperature() {
  if (!mlxReady) { setStatus("MLX not initialized"); return false; }
  setStatus("Aim at forehead");
  float sum = 0;
  int validCount = 0;
  for (int i = 0; i < 7; ++i) {
    const float ambient = mlx.readAmbientTempC();
    const float object = mlx.readObjectTempC();
    Serial.printf("MLX ambient=%.2f C object=%.2f C\n", ambient, object);
    if (isfinite(ambient) && isfinite(object) &&
        object >= -70.0f && object <= 380.0f) {
      sum += object;
      validCount++;
    }
    delay(150);
  }
  if (validCount < 5) {
    setStatus("MLX read invalid");
    return false;
  }
  reading.temperatureC = sum / validCount;
  reading.tempValid = true;
  reading.capturedTempAt = epochNow();
  Serial.printf("Surface temperature saved: %.2f C\n", reading.temperatureC);
  saveReading();
  setStatus("Surface temp saved");
  return true;
}

bool uploadReading() {
  if (!reading.hrValid && !reading.spo2Valid && !reading.tempValid) { setStatus("Nothing to upload"); return false; }
  if (WiFi.status() != WL_CONNECTED) { setStatus("WiFi unavailable"); return false; }
  setStatus("Authenticating...");
  if (!ensureAuth()) { setStatus("Firebase auth failed"); return false; }
  if (lastUploadId.isEmpty()) {
    lastUploadId = String(DEVICE_ID) + "_" + String((uint32_t)esp_random(), HEX) + String((uint32_t)esp_random(), HEX);
    prefs.putString("uploadId", lastUploadId);
  }
  JsonDocument doc;
  JsonObject fields = doc["fields"].to<JsonObject>();
  addStringField(fields, "deviceId", DEVICE_ID);
  addStringField(fields, "anonymousUid", uid);
  addStringField(fields, "measurementType", "prototype");
  addStringField(fields, "uploadedBy", "esp32");
  if (reading.hrValid) { addIntField(fields, "heartRate", reading.heartRate); if (reading.capturedHrAt) addIntField(fields, "heartRateEpoch", reading.capturedHrAt); }
  if (reading.spo2Valid) { addIntField(fields, "spo2", reading.spo2); if (reading.capturedSpo2At) addIntField(fields, "spo2Epoch", reading.capturedSpo2At); }
  if (reading.tempValid) { addDoubleField(fields, "temperatureC", reading.temperatureC); if (reading.capturedTempAt) addIntField(fields, "temperatureEpoch", reading.capturedTempAt); }
  String payload;
  serializeJson(doc, payload);
  String url = String("https://firestore.googleapis.com/v1/projects/") + FIREBASE_PROJECT_ID + "/databases/(default)/documents/deviceReadings/" + uid + "/measurements/" + lastUploadId;
  String response;
  int code = 0;
  setStatus("Uploading...");
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) { setStatus("HTTPS init failed"); return false; }
  http.setTimeout(12000);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  code = http.sendRequest("PATCH", payload);
  response = http.getString();
  http.end();
  if (code == 200) {
    clearReading();
    lastUploadId = "";
    prefs.remove("uploadId");
    sendHeartbeat();
    lastHeartbeatAt = millis();
    setStatus("Upload successful");
    return true;
  }
  Serial.printf("Firestore upload failed: HTTP %d: %s\n", code, response.c_str());
  setStatus("Upload failed; retry");
  return false;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_NEXT, INPUT_PULLUP);
  pinMode(PIN_CAPTURE, INPUT_PULLUP);
  pinMode(PIN_UPLOAD, INPUT_PULLUP);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  Wire.setTimeOut(100);

  displayInit();

  prefs.begin("health", false);
  loadReading();
  lastUploadId = prefs.getString("uploadId", "");
  refreshToken = prefs.getString("refresh", "");
  uid = prefs.getString("uid", "");

  setStatus("Initializing...");

  // Fixed: assign to global `mlxReady` without shadowing it with a local variable
  mlxReady = mlx.begin(0x5A, &Wire);
  if (mlxReady) {
    Serial.println("MLX90614 initialized successfully");
  } else {
    Serial.println("MLX90614 initialization FAILED");
    setStatus("MLX initialization failed");
  }
  Wire.beginTransmission(0x5A);
  uint8_t error = Wire.endTransmission();
  Serial.print("MLX I2C status: ");
  Serial.println(error);

  maxReady = max30102.begin(Wire, I2C_SPEED_STANDARD);
  if (!maxReady) setStatus("MAX30102 missing");
  else {
    max30102.setup(60, 4, 2, 100, 411, 4096);
    max30102.setPulseAmplitudeRed(0x1F);
    max30102.setPulseAmplitudeIR(0x1F);
    max30102.setPulseAmplitudeGreen(0);
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  setStatus("Connecting WiFi...");
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(200);
  if (WiFi.status() == WL_CONNECTED) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    sendHeartbeat();
    lastHeartbeatAt = millis();
    setStatus("Ready - WiFi OK");
  } else setStatus("Offline - can capture");
}

void loop() {
  if (btnNext.pressed()) {
    page = static_cast<Page>((page + 1) % 4);
    statusLine = "NEXT / CAPTURE / UPLOAD";
    drawScreen();
  }
  if (btnCapture.pressed()) {
    if (page == PAGE_HR || page == PAGE_SPO2) capturePulse();
    else if (page == PAGE_TEMP) captureTemperature();
    else setStatus("Select measurement");
  }
  if (btnUpload.pressed()) uploadReading();

  // Periodic 30-second heartbeat when Wi-Fi is connected
  if (WiFi.status() == WL_CONNECTED && (uint32_t)(millis() - lastHeartbeatAt) >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatAt = millis();
    sendHeartbeat();
  }
  delay(10);
}
