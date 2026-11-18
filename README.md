# HealthOS IoT — Hospital Health Monitoring Platform

A production-oriented, responsive IoT hospital health monitoring platform built with **Next.js (App Router)**, **TypeScript**, **Tailwind CSS**, **Firebase (Authentication, Cloud Firestore, Cloud Functions v2, Admin SDK)**, **TanStack Query**, **React Hook Form + Zod**, and **Recharts**.

Designed for hospitals, clinics, pharmacies, and remote healthcare monitoring environments integrating with custom **ESP32-WROOM-32** hardware units (`MAX30102` pulse oximeter + `MLX90614` infrared surface thermometer + `128×64` graphical LCD + `4×4` matrix keypad).

---

## Key Architecture & Security Features

1. **Multi-Tenant Hospital Isolation & 5-Tier RBAC**:
   - Supports **Super Admin**, **Hospital Admin**, **Doctor**, **Nurse**, and **Device Operator** roles (`src/lib/auth/rbac.ts` and `firestore.rules`).
   - Enforces strict hospital-level data isolation (`hospitalId`) so staff and ESP32 devices in one hospital cannot read or modify another hospital's patients, sessions, or measurements.
2. **Patient Registration & 6-Digit Keypad Code Generation**:
   - Automatically generates a unique, non-reusable 6-digit numeric `patientCode` (e.g., `102345`) per hospital (`src/lib/domain/patientCode.ts`) while keeping internal Firestore document IDs (`pat_...`) separate.
   - Treats the keypad code strictly as a session-initiation lookup token, never as standalone proof of identity.
3. **8-Step ESP32 Keypad Verification & Authorized Measurement Sessions**:
   - Verifies both the ESP32's cryptographic HMAC identity (`X-Device-Id` + `X-Device-Secret`) and the 6-digit `patientCode` before creating an authorized `MeasurementSession`.
   - Rejects bare Firebase Anonymous Authentication without registered device credentials.
   - Locks `patientId`, `deviceId`, and `hospitalId` on sessions and measurements so readings can never be reassigned to another patient after upload.
4. **Clinical Sensor Distinctions & Non-Diagnostic Alerts**:
   - Clearly distinguishes `MLX90614` infrared surface temperature (`°C`) from clinically calibrated core body temperature.
   - Labels `MAX30102` pulse rate (`BPM`) and `SpO₂` (`%`) readings as prototype optical measurements unless clinically validated, and provides configurable non-diagnostic threshold alerts (`src/lib/domain/vitalAlerts.ts`).
5. **Offline Queue Synchronization & Clinical Verification**:
   - Accepts batches of offline ESP32 readings with idempotent `measurementId` deduplication, preserves the `patientCode` entered at capture time, marks unverified offline readings as `pending_offline`, and requires clinical staff verification (`verified_offline` / `rejected`).
6. **Nigeria Data Protection Act (NDPA) Privacy Design**:
   - Requires explicit health-data consent tracking (`consentRecorded`), minimizes PII on the ESP32 128×64 LCD (initials + bed only) and in tamper-evident `auditLogs`, and tracks hospital Data Protection Officer (DPO) contact and retention policies.

---

## Project Structure

- `src/types/models.ts` — Strongly typed data models for all 8 Firestore collections (`hospitals`, `users`, `hospitalMembers`, `patients`, `devices`, `measurementSessions`, `measurements`, `auditLogs`).
- `src/lib/validations.ts` — Zod validation schemas for forms and ESP32 API payloads.
- `src/lib/auth/rbac.ts` — Role permission matrix and hospital isolation enforcement.
- `src/lib/domain/patientCode.ts` — Collision-free 6-digit numeric patient code generator.
- `src/lib/domain/vitalAlerts.ts` — Configurable threshold evaluation for MAX30102 and MLX90614 readings.
- `src/lib/domain/iotBackendService.ts` — Core backend service for patient management, device HMAC authentication, session creation, measurement upload, and offline batch synchronization.
- `src/app/api/platform/route.ts` & `src/app/api/iot/route.ts` — Next.js App Router API endpoints.
- `src/components/iot/Esp32HardwareConsole.tsx` — Interactive 128×64 LCD + 4×4 matrix keypad + `NEXT` / `CAPTURE` / `UPLOAD` hardware simulator for testing online & offline workflows directly in the dashboard.
- `functions/src/index.ts` — Firebase Cloud Functions v2 endpoints (`verifyPatientCodeAndCreateSession`, `registerAndAuthorizeDevice`, `uploadVitalMeasurement`, `syncOfflineMeasurements`, `completeMeasurementSession`, `reportDeviceHeartbeat`).
- `firestore.rules` & `firestore.indexes.json` — Production-grade Cloud Firestore Security Rules and composite indexes.
- `docs/ESP32_API_SPECIFICATION.md` — Complete ESP32 REST API contract and Arduino C++ LittleFS/NVS firmware upgrade guide.
- `tests/platform.test.ts` — Automated Vitest suite verifying patient-code uniqueness, hospital isolation, device authorization, measurement uploads, and duplicate/reassignment prevention.

---

## Local Development Instructions

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Configure environment variables**:
   ```bash
   cp .env.example .env.local
   ```
3. **Run automated tests**:
   ```bash
   npm test
   ```
4. **Start the development server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` to access the Hospital Dashboard, test RBAC role & hospital tenant switching in the top bar, and operate the interactive ESP32-WROOM-32 Hardware & Keypad Telemetry Console.

---

## Deployment Instructions (Firebase)

1. **Authenticate with Firebase CLI and select your project**:
   ```bash
   npx -y firebase-tools@latest login
   npx -y firebase-tools@latest use <your-firebase-project-id>
   ```
2. **Deploy Firestore Security Rules and Composite Indexes**:
   ```bash
   npx -y firebase-tools@latest deploy --only firestore:rules,firestore:indexes
   ```
3. **Build and deploy Firebase Cloud Functions v2**:
   ```bash
   cd functions && npm install && npm run build && cd ..
   npx -y firebase-tools@latest deploy --only functions
   ```
4. **Build the Next.js production bundle**:
   ```bash
   npm run build
   npm start
   ```
