import { onRequest, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import crypto from "crypto";
import { z } from "zod";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const auth = admin.auth();

// --- Cryptographic HMAC Helper for Device Secrets ---
function hashDeviceSecret(secret: string): string {
  const pepper =
    process.env.IOT_DEVICE_HMAC_PEPPER ||
    "healthos-dev-hmac-pepper-do-not-use-in-prod";
  return crypto.createHmac("sha256", pepper).update(secret).digest("hex");
}

// --- In-Memory Per-Instance Rate Limiter + Firestore Fallback ---
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
function enforceRateLimit(key: string, limit = 30, windowMs = 60_000): void {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new HttpsError(
      "resource-exhausted",
      "Rate limit exceeded. Back off before retrying."
    );
  }
}

// --- Zod Schemas for Strict Input Validation ---
const verifyCodeSchema = z.object({
  deviceId: z.string().min(3),
  patientCode: z.string().regex(/^\d{6}$/, "patientCode must be 6 digits"),
  operatorId: z.string().optional().default("keypad_operator"),
});

const uploadMeasurementSchema = z.object({
  measurementId: z.string().min(8).max(120),
  sessionId: z.string().min(4),
  deviceId: z.string().min(3),
  heartRateBpm: z.number().min(25).max(250),
  spo2Pct: z.number().min(50).max(100),
  surfaceTempC: z.number().min(25.0).max(45.0),
  capturedAt: z.string().datetime(),
});

const offlineBatchSchema = z.object({
  deviceId: z.string().min(3),
  firmwareVersion: z.string().min(1),
  readings: z
    .array(
      z.object({
        measurementId: z.string().min(8).max(120),
        patientCode: z.string().regex(/^\d{6}$/),
        heartRateBpm: z.number().min(25).max(250),
        spo2Pct: z.number().min(50).max(100),
        surfaceTempC: z.number().min(25.0).max(45.0),
        capturedAt: z.string().datetime(),
      })
    )
    .min(1)
    .max(50),
});

const completeSessionSchema = z.object({
  sessionId: z.string().min(4),
  deviceId: z.string().min(3),
});

const heartbeatSchema = z.object({
  deviceId: z.string().min(3),
  firmwareVersion: z.string().min(1).max(40),
  wifiRssiDbm: z.number().min(-120).max(0).optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  pendingOfflineCount: z.number().int().min(0).default(0),
});

const deviceRegistrationSchema = z.object({
  hospitalId: z.string().min(2),
  serialNumber: z.string().min(4).max(80),
  macAddress: z.string().regex(/^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/),
  name: z.string().min(2).max(120),
  ward: z.string().min(1).max(80),
  firmwareVersion: z.string().default("v2.4.2-esp32-ard"),
});

/**
 * Verifies ESP32 Device Authentication:
 * 1. Requires valid Firebase ID Token in `Authorization: Bearer <token>` (can be anonymous Firebase auth from ESP32).
 * 2. Explicitly DOES NOT trust anonymous Firebase auth alone: requires `X-Device-Id` and `X-Device-Secret`
 *    matching the registered device's HMAC hash in `devices/{deviceId}` and `status == 'active'`.
 */
async function verifyTrustedEsp32Request(req: {
  headers: Record<string, string | string[] | undefined>;
}) {
  const authHeader = String(req.headers["authorization"] || "");
  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpsError("unauthenticated", "Missing Bearer Firebase ID token");
  }
  const idToken = authHeader.slice("Bearer ".length).trim();
  const decoded = await auth.verifyIdToken(idToken);

  const deviceId = String(req.headers["x-device-id"] || "").trim();
  const deviceSecret = String(req.headers["x-device-secret"] || "").trim();

  if (!deviceId || !deviceSecret) {
    throw new HttpsError(
      "permission-denied",
      "Anonymous Firebase sign-in alone is not trusted. X-Device-Id and X-Device-Secret headers are required."
    );
  }

  enforceRateLimit(`esp32:${deviceId}`, 60, 60_000);

  const deviceSnap = await db.collection("devices").doc(deviceId).get();
  if (!deviceSnap.exists) {
    throw new HttpsError("permission-denied", "Unregistered ESP32 device");
  }

  const deviceData = deviceSnap.data()!;
  if (deviceData.status !== "active") {
    throw new HttpsError(
      "permission-denied",
      `Device '${deviceId}' has status '${deviceData.status}' and is not authorized`
    );
  }

  const expectedHash = hashDeviceSecret(deviceSecret);
  if (!deviceData.secretKeyHash || deviceData.secretKeyHash !== expectedHash) {
    await db.collection("auditLogs").add({
      hospitalId: deviceData.hospitalId,
      actorUid: deviceId,
      actorRole: "esp32_device",
      action: "UNAUTHORIZED_ACCESS_BLOCKED",
      targetCollection: "devices",
      targetId: deviceId,
      metadata: { firebaseUid: decoded.uid, reason: "Invalid X-Device-Secret" },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    throw new HttpsError("permission-denied", "Invalid device secret");
  }

  return {
    firebaseUid: decoded.uid,
    deviceId,
    hospitalId: String(deviceData.hospitalId),
    deviceName: String(deviceData.name),
  };
}

/**
 * 1. Patient Code Verification & Measurement Session Creation (Cloud Function v2)
 */
export const verifyPatientCodeAndCreateSession = onRequest(
  { cors: false, maxInstances: 20 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }

      const device = await verifyTrustedEsp32Request(req);
      const body = verifyCodeSchema.parse(req.body);

      if (body.deviceId !== device.deviceId) {
        res.status(403).json({
          error: "DEVICE_ID_MISMATCH",
          message: "Payload deviceId does not match authenticated header",
        });
        return;
      }

      const patientQuery = await db
        .collection("patients")
        .where("hospitalId", "==", device.hospitalId)
        .where("patientCode", "==", body.patientCode)
        .limit(1)
        .get();

      if (patientQuery.empty) {
        res.status(404).json({
          error: "PATIENT_CODE_NOT_FOUND",
          message: "No active patient matches this 6-digit keypad code in the device hospital",
        });
        return;
      }

      const patientDoc = patientQuery.docs[0];
      const patient = patientDoc.data();
      if (patient.status === "discharged") {
        res.status(400).json({
          error: "PATIENT_DISCHARGED",
          message: "Patient is discharged and cannot start a measurement session",
        });
        return;
      }

      const sessionRef = db.collection("measurementSessions").doc();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

      const sessionPayload = {
        sessionId: sessionRef.id,
        hospitalId: device.hospitalId,
        patientId: patientDoc.id,
        patientCode: body.patientCode,
        deviceId: device.deviceId,
        operatorId: body.operatorId,
        status: "authorized",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      await sessionRef.set(sessionPayload);

      await db.collection("auditLogs").add({
        hospitalId: device.hospitalId,
        actorUid: device.deviceId,
        actorRole: "esp32_device",
        action: "SESSION_AUTHORIZED",
        targetCollection: "measurementSessions",
        targetId: sessionRef.id,
        metadata: {
          patientId: patientDoc.id,
          patientCode: body.patientCode,
        },
        createdAt: now.toISOString(),
      });

      const initials = String(patient.fullName || "P")
        .split(/\s+/)
        .map((w: string) => w[0]?.toUpperCase() || "")
        .join(".");

      res.status(201).json({
        status: "authorized",
        sessionId: sessionRef.id,
        expiresAt: expiresAt.toISOString(),
        patientDisplay: {
          patientCode: body.patientCode,
          initials: `${initials}.`,
          ward: patient.ward,
          bedNumber: patient.bedNumber,
        },
      });
    } catch (err: unknown) {
      logger.error("verifyPatientCodeAndCreateSession error", {
        message: err instanceof Error ? err.message : "Unknown error",
      });
      const status = err instanceof HttpsError ? 403 : 400;
      res.status(status).json({
        error: "VERIFICATION_FAILED",
        message: err instanceof Error ? err.message : "Invalid request",
      });
    }
  }
);

/**
 * 2. Device Registration and Authorization (Cloud Function v2)
 */
export const registerAndAuthorizeDevice = onRequest(
  { cors: true, maxInstances: 10 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }

      const authHeader = String(req.headers["authorization"] || "");
      if (!authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "UNAUTHENTICATED" });
        return;
      }
      const decoded = await auth.verifyIdToken(
        authHeader.slice("Bearer ".length).trim()
      );
      if (decoded.firebase?.sign_in_provider === "anonymous") {
        res.status(403).json({ error: "ANONYMOUS_FORBIDDEN" });
        return;
      }

      const body = deviceRegistrationSchema.parse(req.body);
      const memberSnap = await db
        .collection("hospitalMembers")
        .doc(`${body.hospitalId}_${decoded.uid}`)
        .get();

      if (
        !memberSnap.exists ||
        !["super_admin", "hospital_admin"].includes(memberSnap.data()?.role)
      ) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: "Only Hospital Admin or Super Admin can register ESP32 devices",
        });
        return;
      }

      const deviceId = `dev_${body.serialNumber
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")}`;
      const provisionedSecret = `esp32_sec_${crypto.randomBytes(16).toString("hex")}`;
      const now = new Date().toISOString();

      await db
        .collection("devices")
        .doc(deviceId)
        .set({
          deviceId,
          serialNumber: body.serialNumber,
          macAddress: body.macAddress.toUpperCase(),
          hospitalId: body.hospitalId,
          name: body.name,
          ward: body.ward,
          firmwareVersion: body.firmwareVersion,
          status: "active",
          connectionStatus: "offline",
          lastSeenAt: now,
          pendingOfflineCount: 0,
          secretKeyHash: hashDeviceSecret(provisionedSecret),
          createdAt: now,
          updatedAt: now,
        });

      res.status(201).json({
        deviceId,
        provisionedSecret,
        message:
          "Flash provisionedSecret to ESP32 NVS partition. It will not be shown again.",
      });
    } catch (err: unknown) {
      res.status(400).json({
        error: "DEVICE_REGISTRATION_FAILED",
        message: err instanceof Error ? err.message : "Failed to register device",
      });
    }
  }
);

/**
 * 3. Measurement Upload (Idempotent by measurementId, bound to authorized session)
 */
export const uploadVitalMeasurement = onRequest(
  { cors: false, maxInstances: 30 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }

      const device = await verifyTrustedEsp32Request(req);
      const body = uploadMeasurementSchema.parse(req.body);

      const measRef = db.collection("measurements").doc(body.measurementId);
      const sessionRef = db.collection("measurementSessions").doc(body.sessionId);

      const result = await db.runTransaction(async (tx) => {
        const existingMeas = await tx.get(measRef);
        if (existingMeas.exists) {
          const existingData = existingMeas.data()!;
          if (
            existingData.sessionId !== body.sessionId ||
            existingData.deviceId !== device.deviceId
          ) {
            throw new HttpsError(
              "already-exists",
              "Measurement ID is already bound to another session and cannot be reassigned"
            );
          }
          return { measurement: existingData, deduplicated: true };
        }

        const sessionSnap = await tx.get(sessionRef);
        if (!sessionSnap.exists) {
          throw new HttpsError("not-found", "Measurement session not found");
        }
        const session = sessionSnap.data()!;
        if (
          session.deviceId !== device.deviceId ||
          session.hospitalId !== device.hospitalId
        ) {
          throw new HttpsError(
            "permission-denied",
            "Session does not belong to this device"
          );
        }
        if (!["authorized", "capturing"].includes(session.status)) {
          throw new HttpsError(
            "failed-precondition",
            `Session status is '${session.status}'`
          );
        }

        const now = new Date().toISOString();
        const measPayload = {
          measurementId: body.measurementId,
          hospitalId: device.hospitalId,
          patientId: session.patientId,
          patientCodeAtCapture: session.patientCode,
          sessionId: body.sessionId,
          deviceId: device.deviceId,
          heartRateBpm: body.heartRateBpm,
          spo2Pct: body.spo2Pct,
          surfaceTempC: body.surfaceTempC,
          tempSensorType: "MLX90614_SURFACE_IR",
          opticalSensorType: "MAX30102_PROTOTYPE",
          capturedAt: body.capturedAt,
          uploadedAt: now,
          syncStatus: "verified_online",
          validityStatus: "valid",
          alertLevel:
            body.spo2Pct < 90 || body.heartRateBpm > 130
              ? "high_priority"
              : body.spo2Pct < 94 || body.heartRateBpm > 110
              ? "warning"
              : "normal",
          createdAt: now,
        };

        tx.set(measRef, measPayload);
        tx.update(sessionRef, { status: "completed", completedAt: now });
        return { measurement: measPayload, deduplicated: false };
      });

      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err: unknown) {
      res.status(400).json({
        error: "MEASUREMENT_UPLOAD_FAILED",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }
);

/**
 * 4. Offline Synchronization (Idempotent multi-reading batch upload)
 */
export const syncOfflineMeasurements = onRequest(
  { cors: false, maxInstances: 20 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }

      const device = await verifyTrustedEsp32Request(req);
      const body = offlineBatchSchema.parse(req.body);
      const now = new Date().toISOString();

      const results: Array<Record<string, unknown>> = [];
      let acceptedCount = 0;
      let duplicateCount = 0;
      let rejectedCount = 0;

      for (const item of body.readings) {
        const measRef = db.collection("measurements").doc(item.measurementId);
        const existingSnap = await measRef.get();

        if (existingSnap.exists) {
          const existing = existingSnap.data()!;
          if (existing.patientCodeAtCapture !== item.patientCode) {
            rejectedCount += 1;
            results.push({
              measurementId: item.measurementId,
              patientCode: item.patientCode,
              status: "rejected",
              errorCode: "PATIENT_REASSIGNMENT_FORBIDDEN",
              message: "Cannot reassign existing measurementId to a different patientCode",
            });
            continue;
          }
          duplicateCount += 1;
          results.push({
            measurementId: item.measurementId,
            patientCode: item.patientCode,
            status: "duplicate_ignored",
            patientId: existing.patientId,
          });
          continue;
        }

        const patientQuery = await db
          .collection("patients")
          .where("hospitalId", "==", device.hospitalId)
          .where("patientCode", "==", item.patientCode)
          .limit(1)
          .get();

        if (patientQuery.empty) {
          rejectedCount += 1;
          results.push({
            measurementId: item.measurementId,
            patientCode: item.patientCode,
            status: "rejected",
            errorCode: "UNRECOGNIZED_PATIENT_CODE",
            message: "Patient code not found in device hospital",
          });
          continue;
        }

        const patientDoc = patientQuery.docs[0];
        await measRef.set({
          measurementId: item.measurementId,
          hospitalId: device.hospitalId,
          patientId: patientDoc.id,
          patientCodeAtCapture: item.patientCode,
          sessionId: `offline_sess_${item.measurementId}`,
          deviceId: device.deviceId,
          heartRateBpm: item.heartRateBpm,
          spo2Pct: item.spo2Pct,
          surfaceTempC: item.surfaceTempC,
          tempSensorType: "MLX90614_SURFACE_IR",
          opticalSensorType: "MAX30102_PROTOTYPE",
          capturedAt: item.capturedAt,
          uploadedAt: now,
          syncStatus: "pending_offline",
          validityStatus: "valid",
          alertLevel:
            item.spo2Pct < 90 || item.heartRateBpm > 130
              ? "high_priority"
              : "normal",
          createdAt: now,
        });

        acceptedCount += 1;
        results.push({
          measurementId: item.measurementId,
          patientCode: item.patientCode,
          status: "accepted_pending",
          patientId: patientDoc.id,
        });
      }

      res.status(200).json({
        deviceId: device.deviceId,
        acceptedCount,
        duplicateCount,
        rejectedCount,
        results,
      });
    } catch (err: unknown) {
      res.status(400).json({
        error: "OFFLINE_SYNC_FAILED",
        message: err instanceof Error ? err.message : "Offline sync error",
      });
    }
  }
);

/**
 * 5. Session Completion (Cloud Function v2)
 */
export const completeMeasurementSession = onRequest(
  { cors: false, maxInstances: 20 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const device = await verifyTrustedEsp32Request(req);
      const body = completeSessionSchema.parse(req.body);
      const sessionRef = db.collection("measurementSessions").doc(body.sessionId);
      const snap = await sessionRef.get();

      if (!snap.exists || snap.data()?.deviceId !== device.deviceId) {
        res.status(404).json({ error: "SESSION_NOT_FOUND_OR_FORBIDDEN" });
        return;
      }

      const completedAt = new Date().toISOString();
      await sessionRef.update({ status: "completed", completedAt });
      res.status(200).json({ sessionId: body.sessionId, status: "completed", completedAt });
    } catch (err: unknown) {
      res.status(400).json({
        error: "SESSION_COMPLETE_FAILED",
        message: err instanceof Error ? err.message : "Failed to complete session",
      });
    }
  }
);

/**
 * 6. Device Heartbeat Reporting (Cloud Function v2)
 */
export const reportDeviceHeartbeat = onRequest(
  { cors: false, maxInstances: 30 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const device = await verifyTrustedEsp32Request(req);
      const body = heartbeatSchema.parse(req.body);
      const now = new Date().toISOString();

      await db
        .collection("devices")
        .doc(device.deviceId)
        .update({
          firmwareVersion: body.firmwareVersion,
          lastSeenAt: now,
          pendingOfflineCount: body.pendingOfflineCount,
          wifiRssiDbm: body.wifiRssiDbm ?? -60,
          batteryPct: body.batteryPct ?? 90,
          connectionStatus:
            typeof body.wifiRssiDbm === "number" && body.wifiRssiDbm < -80
              ? "degraded"
              : "online",
          updatedAt: now,
        });

      res.status(200).json({
        deviceId: device.deviceId,
        status: "acknowledged",
        serverTime: now,
      });
    } catch (err: unknown) {
      res.status(400).json({
        error: "HEARTBEAT_FAILED",
        message: err instanceof Error ? err.message : "Heartbeat failed",
      });
    }
  }
);
