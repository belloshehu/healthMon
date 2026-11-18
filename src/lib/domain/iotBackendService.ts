import crypto from "crypto";
import {
  Hospital,
  AppUser,
  HospitalMember,
  Patient,
  MonitoringDevice,
  MeasurementSession,
  VitalMeasurement,
  AuditLogEntry,
  DeviceLifecycleStatus,
} from "@/types/models";
import {
  SEED_HOSPITALS,
  SEED_USERS,
  SEED_HOSPITAL_MEMBERS,
  SEED_PATIENTS,
  SEED_DEVICES,
  SEED_MEASUREMENT_SESSIONS,
  SEED_MEASUREMENTS,
  SEED_AUDIT_LOGS,
  hashDeviceSecret,
} from "@/lib/domain/seedData";
import {
  generateUniquePatientCode,
  generateInternalPatientId,
} from "@/lib/domain/patientCode";
import {
  evaluateVitalMeasurement,
  DEFAULT_HOSPITAL_THRESHOLDS,
} from "@/lib/domain/vitalAlerts";
import {
  AuthenticatedActor,
  AuthorizationError,
  enforceHospitalAccess,
} from "@/lib/auth/rbac";
import {
  patientRegistrationSchema,
  deviceRegistrationSchema,
  verifyPatientCodeRequestSchema,
  uploadMeasurementRequestSchema,
  offlineBatchSyncRequestSchema,
  completeSessionRequestSchema,
  deviceHeartbeatRequestSchema,
  hospitalSettingsSchema,
  staffMemberSchema,
} from "@/lib/validations";

export interface Esp32DeviceCredentials {
  deviceId: string;
  deviceSecret: string;
  firebaseUid: string;
  isAnonymousAuthOnly?: boolean;
}

export interface OfflineSyncItemResult {
  measurementId: string;
  patientCode: string;
  status: "accepted_pending" | "duplicate_ignored" | "rejected";
  patientId?: string;
  errorCode?: string;
  message: string;
}

export class HospitalIoTPlatformStore {
  public hospitals: Map<string, Hospital> = new Map();
  public users: Map<string, AppUser> = new Map();
  public hospitalMembers: Map<string, HospitalMember> = new Map();
  public patients: Map<string, Patient> = new Map();
  // Historical set of all patient codes ever issued per hospital (never reused)
  public issuedPatientCodesByHospital: Map<string, Set<string>> = new Map();
  public devices: Map<string, MonitoringDevice> = new Map();
  public measurementSessions: Map<string, MeasurementSession> = new Map();
  public measurements: Map<string, VitalMeasurement> = new Map();
  public auditLogs: AuditLogEntry[] = [];
  private rateLimitBuckets: Map<string, { count: number; windowStartMs: number }> =
    new Map();

  constructor(loadSeed = true) {
    if (loadSeed) {
      this.resetToSeed();
    }
  }

  public resetToSeed(): void {
    this.hospitals.clear();
    this.users.clear();
    this.hospitalMembers.clear();
    this.patients.clear();
    this.issuedPatientCodesByHospital.clear();
    this.devices.clear();
    this.measurementSessions.clear();
    this.measurements.clear();
    this.auditLogs = [];
    this.rateLimitBuckets.clear();

    for (const h of SEED_HOSPITALS) {
      this.hospitals.set(h.id, structuredClone(h));
      this.issuedPatientCodesByHospital.set(h.id, new Set());
    }
    for (const u of SEED_USERS) {
      this.users.set(u.uid, structuredClone(u));
    }
    for (const m of SEED_HOSPITAL_MEMBERS) {
      this.hospitalMembers.set(m.id, structuredClone(m));
    }
    for (const p of SEED_PATIENTS) {
      this.patients.set(p.id, structuredClone(p));
      const set =
        this.issuedPatientCodesByHospital.get(p.hospitalId) || new Set();
      set.add(p.patientCode);
      this.issuedPatientCodesByHospital.set(p.hospitalId, set);
    }
    for (const d of SEED_DEVICES) {
      this.devices.set(d.id, structuredClone(d));
    }
    for (const s of SEED_MEASUREMENT_SESSIONS) {
      this.measurementSessions.set(s.id, structuredClone(s));
    }
    for (const m of SEED_MEASUREMENTS) {
      this.measurements.set(m.id, structuredClone(m));
    }
    this.auditLogs = structuredClone(SEED_AUDIT_LOGS);
  }

  public checkRateLimit(key: string, maxRequests = 30, windowMs = 60_000): void {
    const now = Date.now();
    const bucket = this.rateLimitBuckets.get(key);
    if (!bucket || now - bucket.windowStartMs > windowMs) {
      this.rateLimitBuckets.set(key, { count: 1, windowStartMs: now });
      return;
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      throw new AuthorizationError(
        `Rate limit exceeded for '${key}'. Please retry after backoff window.`,
        "RATE_LIMIT_EXCEEDED",
        429
      );
    }
  }

  private recordAuditLog(
    entry: Omit<AuditLogEntry, "id" | "createdAt">
  ): AuditLogEntry {
    const log: AuditLogEntry = {
      ...entry,
      id: `aud_${crypto.randomBytes(6).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    this.auditLogs.unshift(log);
    return log;
  }

  /**
   * Authenticates and authorizes an ESP32 hardware device.
   * CRITICAL REQUIREMENT:
   * - Do NOT treat anonymous Firebase sign-in alone as proof that a device is trusted.
   * - Device must exist, belong to an active hospital, have status === 'active',
   *   and present a valid cryptographic deviceSecret matching its stored HMAC hash.
   */
  public authenticateEsp32Device(
    creds: Esp32DeviceCredentials
  ): MonitoringDevice {
    if (!creds || !creds.firebaseUid) {
      throw new AuthorizationError(
        "Missing Firebase Authentication token from ESP32",
        "DEVICE_UNAUTHENTICATED",
        401
      );
    }

    if (creds.isAnonymousAuthOnly || !creds.deviceId || !creds.deviceSecret) {
      throw new AuthorizationError(
        "Anonymous Firebase sign-in alone is not trusted. Registered X-Device-Id and X-Device-Secret credentials are required.",
        "ANONYMOUS_DEVICE_UNTRUSTED",
        401
      );
    }

    this.checkRateLimit(`device:${creds.deviceId}`, 60, 60_000);

    const device = this.devices.get(creds.deviceId);
    if (!device) {
      throw new AuthorizationError(
        `Device '${creds.deviceId}' is not registered`,
        "DEVICE_NOT_FOUND",
        403
      );
    }

    if (device.status !== "active") {
      throw new AuthorizationError(
        `Device '${creds.deviceId}' is currently '${device.status}' and not authorized to upload or create sessions`,
        "DEVICE_INACTIVE_OR_REVOKED",
        403
      );
    }

    const computedHash = hashDeviceSecret(creds.deviceSecret);
    if (!device.secretKeyHash || computedHash !== device.secretKeyHash) {
      this.recordAuditLog({
        hospitalId: device.hospitalId,
        actorUid: creds.deviceId,
        actorRole: "esp32_device",
        action: "UNAUTHORIZED_ACCESS_BLOCKED",
        targetCollection: "devices",
        targetId: device.id,
        metadata: { reason: "Invalid X-Device-Secret HMAC" },
      });
      throw new AuthorizationError(
        "Invalid device cryptographic secret",
        "INVALID_DEVICE_SECRET",
        403
      );
    }

    return device;
  }

  /**
   * Registers a new patient and allocates a unique, non-reusable 6-digit numeric keypad code.
   * Internal Firestore document ID (`id`) is strictly separate from `patientCode`.
   */
  public registerPatient(
    actor: AuthenticatedActor,
    rawInput: unknown,
    forcedCodeForTesting?: string
  ): Patient {
    const input = patientRegistrationSchema.parse(rawInput);
    enforceHospitalAccess(actor, input.hospitalId, "patient:register");

    const hospitalCodes =
      this.issuedPatientCodesByHospital.get(input.hospitalId) || new Set();

    let patientCode: string;
    if (forcedCodeForTesting) {
      if (hospitalCodes.has(forcedCodeForTesting)) {
        throw new Error(
          `Patient code ${forcedCodeForTesting} has already been issued in hospital ${input.hospitalId} and cannot be reused`
        );
      }
      patientCode = forcedCodeForTesting;
    } else {
      patientCode = generateUniquePatientCode(hospitalCodes);
    }

    hospitalCodes.add(patientCode);
    this.issuedPatientCodesByHospital.set(input.hospitalId, hospitalCodes);

    const internalId = generateInternalPatientId();
    const doctor = this.users.get(input.assignedDoctorId);
    const nurse = this.users.get(input.assignedNurseId);
    const now = new Date().toISOString();

    const patient: Patient = {
      id: internalId,
      hospitalId: input.hospitalId,
      patientCode,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth,
      sex: input.sex,
      ward: input.ward,
      bedNumber: input.bedNumber,
      assignedDoctorId: input.assignedDoctorId,
      assignedDoctorName: doctor?.displayName || "Assigned Physician",
      assignedNurseId: input.assignedNurseId,
      assignedNurseName: nurse?.displayName || "Assigned Nurse",
      status: input.status,
      consentRecorded: input.consentRecorded,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.uid,
    };

    this.patients.set(patient.id, patient);

    this.recordAuditLog({
      hospitalId: input.hospitalId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action: "PATIENT_REGISTERED",
      targetCollection: "patients",
      targetId: patient.id,
      metadata: {
        patientCode: patient.patientCode,
        ward: patient.ward,
        ndpaConsentVerified: patient.consentRecorded,
      },
    });

    return patient;
  }

  /**
   * Lists patients for a specific hospital, enforcing hospital-level data isolation.
   */
  public listHospitalPatients(
    actor: AuthenticatedActor,
    hospitalId: string
  ): Patient[] {
    enforceHospitalAccess(actor, hospitalId, "patient:view");
    return Array.from(this.patients.values())
      .filter((p) => p.hospitalId === hospitalId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Registers a new ESP32 monitoring device and returns its one-time provisioning secret.
   */
  public registerDevice(
    actor: AuthenticatedActor,
    rawInput: unknown
  ): { device: MonitoringDevice; provisionedSecret: string } {
    const input = deviceRegistrationSchema.parse(rawInput);
    enforceHospitalAccess(actor, input.hospitalId, "device:register");

    const deviceId = `dev_${input.serialNumber
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")}`;

    if (this.devices.has(deviceId)) {
      throw new Error(`Device with serial number '${input.serialNumber}' is already registered`);
    }

    const provisionedSecret = `esp32_sec_${crypto.randomBytes(16).toString("hex")}`;
    const now = new Date().toISOString();

    const device: MonitoringDevice = {
      id: deviceId,
      deviceId,
      serialNumber: input.serialNumber,
      macAddress: input.macAddress.toUpperCase(),
      hospitalId: input.hospitalId,
      name: input.name,
      ward: input.ward,
      firmwareVersion: input.firmwareVersion,
      hardwareRevision: input.hardwareRevision,
      status: "active",
      connectionStatus: "offline",
      lastSeenAt: now,
      batteryPct: 100,
      wifiRssiDbm: -55,
      pendingOfflineCount: 0,
      secretKeyHash: hashDeviceSecret(provisionedSecret),
      createdAt: now,
      updatedAt: now,
    };

    this.devices.set(device.id, device);

    this.recordAuditLog({
      hospitalId: input.hospitalId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action: "DEVICE_REGISTERED",
      targetCollection: "devices",
      targetId: device.id,
      metadata: {
        serialNumber: device.serialNumber,
        ward: device.ward,
      },
    });

    return { device, provisionedSecret };
  }

  public updateDeviceStatus(
    actor: AuthenticatedActor,
    deviceId: string,
    status: DeviceLifecycleStatus
  ): MonitoringDevice {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device '${deviceId}' not found`);
    }
    enforceHospitalAccess(actor, device.hospitalId, "device:operate");

    device.status = status;
    device.updatedAt = new Date().toISOString();
    if (status !== "active") {
      device.connectionStatus = "offline";
    }
    this.devices.set(device.id, device);

    this.recordAuditLog({
      hospitalId: device.hospitalId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action: "DEVICE_STATUS_CHANGED",
      targetCollection: "devices",
      targetId: device.id,
      metadata: { newStatus: status },
    });

    return device;
  }

  /**
   * Step 2-5 of ESP32 Keypad Workflow:
   * - Verifies device authentication & active status.
   * - Looks up patient by 6-digit `patientCode` strictly within the device's `hospitalId`.
   * - Rejects discharged or non-existent patients or patients from another hospital.
   * - Creates an authorized `MeasurementSession` bound to `(hospitalId, patientId, deviceId)`.
   */
  public verifyPatientCodeAndCreateSession(
    creds: Esp32DeviceCredentials,
    rawBody: unknown
  ): {
    session: MeasurementSession;
    patientDisplay: {
      patientCode: string;
      initials: string;
      ward: string;
      bedNumber: string;
    };
  } {
    const device = this.authenticateEsp32Device(creds);
    const body = verifyPatientCodeRequestSchema.parse(rawBody);

    if (body.deviceId !== device.deviceId) {
      throw new AuthorizationError(
        "Device ID in payload does not match authenticated device header",
        "DEVICE_ID_MISMATCH",
        403
      );
    }

    const matchingPatient = Array.from(this.patients.values()).find(
      (p) =>
        p.hospitalId === device.hospitalId && p.patientCode === body.patientCode
    );

    if (!matchingPatient) {
      this.recordAuditLog({
        hospitalId: device.hospitalId,
        actorUid: device.deviceId,
        actorRole: "esp32_device",
        action: "UNAUTHORIZED_ACCESS_BLOCKED",
        targetCollection: "patients",
        targetId: `code_${body.patientCode}`,
        metadata: {
          reason: "Patient code not found in device hospital scope",
          patientCode: body.patientCode,
        },
      });
      throw new AuthorizationError(
        `No active patient with keypad code '${body.patientCode}' found in hospital '${device.hospitalId}'`,
        "PATIENT_CODE_NOT_FOUND",
        404
      );
    }

    if (matchingPatient.status === "discharged") {
      throw new AuthorizationError(
        `Patient '${body.patientCode}' is discharged and cannot start a new measurement session`,
        "PATIENT_DISCHARGED",
        400
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15-minute session window
    const sessionId = `sess_${crypto.randomBytes(8).toString("hex")}`;

    const session: MeasurementSession = {
      id: sessionId,
      sessionId,
      hospitalId: device.hospitalId,
      patientId: matchingPatient.id,
      patientName: matchingPatient.fullName,
      patientCode: matchingPatient.patientCode,
      deviceId: device.deviceId,
      deviceName: device.name,
      operatorId: body.operatorId || "keypad_operator",
      operatorName: body.operatorId || "Keypad Operator",
      status: "authorized",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.measurementSessions.set(session.id, session);

    // Update device lastSeenAt
    device.lastSeenAt = now.toISOString();
    device.connectionStatus = "online";
    device.updatedAt = now.toISOString();
    this.devices.set(device.id, device);

    // Build privacy-preserving initials for the 128x64 graphical LCD confirmation screen
    const nameParts = matchingPatient.fullName
      .replace(/\(Synthetic\)/gi, "")
      .trim()
      .split(/\s+/);
    const initials = nameParts
      .map((part) => part[0]?.toUpperCase() || "")
      .join(".");

    this.recordAuditLog({
      hospitalId: device.hospitalId,
      actorUid: device.deviceId,
      actorRole: "esp32_device",
      action: "SESSION_AUTHORIZED",
      targetCollection: "measurementSessions",
      targetId: session.id,
      metadata: {
        patientId: matchingPatient.id,
        patientCode: matchingPatient.patientCode,
        deviceId: device.deviceId,
      },
    });

    return {
      session,
      patientDisplay: {
        patientCode: matchingPatient.patientCode,
        initials: `${initials}.`,
        ward: matchingPatient.ward,
        bedNumber: matchingPatient.bedNumber,
      },
    };
  }

  /**
   * Step 7 of ESP32 Workflow:
   * Uploads a vital signs measurement associated with an authorized `sessionId`.
   * - Idempotent by `measurementId` (safe retries if network drops mid-response).
   * - Binds reading to the session's verified `patientId` (never trusts a raw patientId from the client).
   * - Prevents measurements from ever being reassigned to a different patient after upload.
   */
  public uploadMeasurement(
    creds: Esp32DeviceCredentials,
    rawBody: unknown
  ): { measurement: VitalMeasurement; deduplicated: boolean } {
    const device = this.authenticateEsp32Device(creds);
    const body = uploadMeasurementRequestSchema.parse(rawBody);

    if (body.deviceId !== device.deviceId) {
      throw new AuthorizationError(
        "Device ID mismatch between header and measurement payload",
        "DEVICE_ID_MISMATCH",
        403
      );
    }

    // Check idempotency: if measurementId already exists
    const existing = this.measurements.get(body.measurementId);
    if (existing) {
      // Prevent reassignment to a different session, device, or patient!
      if (
        existing.sessionId !== body.sessionId ||
        existing.deviceId !== device.deviceId
      ) {
        throw new AuthorizationError(
          `Measurement ID '${body.measurementId}' is already bound to session '${existing.sessionId}' and cannot be reassigned`,
          "MEASUREMENT_REASSIGNMENT_FORBIDDEN",
          409
        );
      }
      return { measurement: existing, deduplicated: true };
    }

    const session = this.measurementSessions.get(body.sessionId);
    if (!session) {
      throw new AuthorizationError(
        `Measurement session '${body.sessionId}' does not exist`,
        "SESSION_NOT_FOUND",
        404
      );
    }

    if (
      session.hospitalId !== device.hospitalId ||
      session.deviceId !== device.deviceId
    ) {
      throw new AuthorizationError(
        `Session '${body.sessionId}' does not belong to device '${device.deviceId}'`,
        "SESSION_DEVICE_MISMATCH",
        403
      );
    }

    if (session.status !== "authorized" && session.status !== "capturing") {
      throw new AuthorizationError(
        `Session '${body.sessionId}' is '${session.status}' and cannot accept new measurements`,
        "SESSION_CLOSED_OR_EXPIRED",
        400
      );
    }

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      session.status = "expired";
      this.measurementSessions.set(session.id, session);
      throw new AuthorizationError(
        `Session '${body.sessionId}' has expired`,
        "SESSION_EXPIRED",
        400
      );
    }

    const hospital = this.hospitals.get(device.hospitalId);
    const thresholds =
      hospital?.alertThresholds || DEFAULT_HOSPITAL_THRESHOLDS;
    const evaluation = evaluateVitalMeasurement(
      {
        heartRateBpm: body.heartRateBpm,
        spo2Pct: body.spo2Pct,
        surfaceTempC: body.surfaceTempC,
      },
      thresholds
    );

    const now = new Date().toISOString();
    const measurement: VitalMeasurement = {
      id: body.measurementId,
      measurementId: body.measurementId,
      hospitalId: device.hospitalId,
      patientId: session.patientId,
      patientName: session.patientName,
      patientCodeAtCapture: session.patientCode,
      sessionId: session.sessionId,
      deviceId: device.deviceId,
      deviceName: device.name,
      heartRateBpm: body.heartRateBpm,
      spo2Pct: body.spo2Pct,
      surfaceTempC: body.surfaceTempC,
      tempSensorType: "MLX90614_SURFACE_IR",
      opticalSensorType: "MAX30102_PROTOTYPE",
      capturedAt: body.capturedAt,
      uploadedAt: now,
      syncStatus: "verified_online",
      validityStatus: evaluation.validityStatus,
      alertLevel: evaluation.alertLevel,
      alertFlags: evaluation.alertFlags,
      createdAt: now,
    };

    this.measurements.set(measurement.id, measurement);

    // Mark session as completed upon upload and update patient status if high priority alert
    session.status = "completed";
    session.completedAt = now;
    this.measurementSessions.set(session.id, session);

    const patient = this.patients.get(session.patientId);
    if (patient) {
      if (evaluation.alertLevel === "high_priority") {
        patient.status = "critical";
      } else if (
        evaluation.alertLevel === "warning" &&
        patient.status === "stable"
      ) {
        patient.status = "attention";
      }
      patient.updatedAt = now;
      this.patients.set(patient.id, patient);
    }

    device.lastSeenAt = now;
    device.connectionStatus = "online";
    device.updatedAt = now;
    this.devices.set(device.id, device);

    this.recordAuditLog({
      hospitalId: device.hospitalId,
      actorUid: device.deviceId,
      actorRole: "esp32_device",
      action: "MEASUREMENT_UPLOADED",
      targetCollection: "measurements",
      targetId: measurement.id,
      metadata: {
        sessionId: session.id,
        patientId: session.patientId,
        alertLevel: measurement.alertLevel,
      },
    });

    return { measurement, deduplicated: false };
  }

  /**
   * Attempts to reassign a measurement to another patient — strictly forbidden!
   * Exposed as an explicit method so tests can verify immutability enforcement.
   */
  public reassignMeasurementPatient(
    _actor: AuthenticatedActor,
    measurementId: string,
    newPatientId: string
  ): never {
    const existing = this.measurements.get(measurementId);
    if (!existing) {
      throw new Error(`Measurement '${measurementId}' not found`);
    }
    throw new AuthorizationError(
      `Immutable patient association violation: measurement '${measurementId}' is permanently bound to patient '${existing.patientId}' and cannot be reassigned to '${newPatientId}'`,
      "PATIENT_REASSIGNMENT_FORBIDDEN",
      403
    );
  }

  /**
   * Offline Batch Synchronization Endpoint Logic:
   * - Authenticates the ESP32 device.
   * - Processes multiple offline queued measurements idempotently by `measurementId`.
   * - Preserves the `patientCode` entered at capture time.
   * - Verifies that `patientCode` maps to a patient in the device's `hospitalId`.
   * - Marks accepted offline readings as `pending_offline` until clinical verification.
   * - Prevents any existing pending/verified reading from being attached to a different patient on retry.
   */
  public syncOfflineMeasurements(
    creds: Esp32DeviceCredentials,
    rawBody: unknown
  ): {
    deviceId: string;
    acceptedCount: number;
    duplicateCount: number;
    rejectedCount: number;
    results: OfflineSyncItemResult[];
  } {
    const device = this.authenticateEsp32Device(creds);
    const body = offlineBatchSyncRequestSchema.parse(rawBody);

    if (body.deviceId !== device.deviceId) {
      throw new AuthorizationError(
        "Device ID mismatch in offline synchronization request",
        "DEVICE_ID_MISMATCH",
        403
      );
    }

    const hospital = this.hospitals.get(device.hospitalId);
    const thresholds =
      hospital?.alertThresholds || DEFAULT_HOSPITAL_THRESHOLDS;
    const now = new Date().toISOString();

    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;
    const results: OfflineSyncItemResult[] = [];

    for (const item of body.readings) {
      const existing = this.measurements.get(item.measurementId);
      if (existing) {
        // Ensure retry does NOT attempt to change the patientCode or attach to a different patient
        if (existing.patientCodeAtCapture !== item.patientCode) {
          rejectedCount += 1;
          results.push({
            measurementId: item.measurementId,
            patientCode: item.patientCode,
            status: "rejected",
            errorCode: "PATIENT_REASSIGNMENT_FORBIDDEN",
            message: `Measurement '${item.measurementId}' was originally captured for patient code '${existing.patientCodeAtCapture}' and cannot be reassigned to '${item.patientCode}'`,
          });
          continue;
        }

        duplicateCount += 1;
        results.push({
          measurementId: item.measurementId,
          patientCode: item.patientCode,
          status: "duplicate_ignored",
          patientId: existing.patientId,
          message: "Already synchronized; idempotent retry acknowledged",
        });
        continue;
      }

      // Verify patient association in the device's hospital
      const patient = Array.from(this.patients.values()).find(
        (p) =>
          p.hospitalId === device.hospitalId &&
          p.patientCode === item.patientCode
      );

      if (!patient) {
        rejectedCount += 1;
        results.push({
          measurementId: item.measurementId,
          patientCode: item.patientCode,
          status: "rejected",
          errorCode: "UNRECOGNIZED_PATIENT_CODE",
          message: `Patient code '${item.patientCode}' does not match any patient in hospital '${device.hospitalId}'`,
        });
        continue;
      }

      const evaluation = evaluateVitalMeasurement(
        {
          heartRateBpm: item.heartRateBpm,
          spo2Pct: item.spo2Pct,
          surfaceTempC: item.surfaceTempC,
        },
        thresholds
      );

      const syntheticSessionId = `offline_sess_${item.measurementId}`;
      const measurement: VitalMeasurement = {
        id: item.measurementId,
        measurementId: item.measurementId,
        hospitalId: device.hospitalId,
        patientId: patient.id,
        patientName: patient.fullName,
        patientCodeAtCapture: item.patientCode,
        sessionId: syntheticSessionId,
        deviceId: device.deviceId,
        deviceName: device.name,
        heartRateBpm: item.heartRateBpm,
        spo2Pct: item.spo2Pct,
        surfaceTempC: item.surfaceTempC,
        tempSensorType: "MLX90614_SURFACE_IR",
        opticalSensorType: "MAX30102_PROTOTYPE",
        capturedAt: item.capturedAt,
        uploadedAt: now,
        syncStatus: "pending_offline",
        validityStatus: evaluation.validityStatus,
        alertLevel: evaluation.alertLevel,
        alertFlags: evaluation.alertFlags,
        createdAt: now,
      };

      this.measurements.set(measurement.id, measurement);
      acceptedCount += 1;

      results.push({
        measurementId: item.measurementId,
        patientCode: item.patientCode,
        status: "accepted_pending",
        patientId: patient.id,
        message:
          "Captured offline reading stored as pending_offline awaiting clinical verification",
      });
    }

    device.lastSeenAt = now;
    device.firmwareVersion = body.firmwareVersion;
    device.connectionStatus = "online";
    device.pendingOfflineCount = Array.from(this.measurements.values()).filter(
      (m) =>
        m.deviceId === device.deviceId && m.syncStatus === "pending_offline"
    ).length;
    device.updatedAt = now;
    this.devices.set(device.id, device);

    this.recordAuditLog({
      hospitalId: device.hospitalId,
      actorUid: device.deviceId,
      actorRole: "esp32_device",
      action: "OFFLINE_BATCH_SYNCED",
      targetCollection: "measurements",
      targetId: device.deviceId,
      metadata: {
        acceptedCount,
        duplicateCount,
        rejectedCount,
      },
    });

    return {
      deviceId: device.deviceId,
      acceptedCount,
      duplicateCount,
      rejectedCount,
      results,
    };
  }

  /**
   * Allows a Doctor, Nurse, or Hospital Admin to clinically verify or reject a `pending_offline` reading.
   * Strictly prevents changing the patientId on the pending reading.
   */
  public verifyOfflineMeasurement(
    actor: AuthenticatedActor,
    measurementId: string,
    decision: "verified_offline" | "rejected",
    rejectionReason?: string
  ): VitalMeasurement {
    const measurement = this.measurements.get(measurementId);
    if (!measurement) {
      throw new Error(`Measurement '${measurementId}' not found`);
    }

    enforceHospitalAccess(
      actor,
      measurement.hospitalId,
      "measurement:verify_offline"
    );

    if (measurement.syncStatus !== "pending_offline") {
      throw new Error(
        `Measurement '${measurementId}' has syncStatus '${measurement.syncStatus}' and is not pending verification`
      );
    }

    const now = new Date().toISOString();
    measurement.syncStatus = decision;
    measurement.verifiedByUid = actor.uid;
    measurement.verifiedAt = now;
    if (decision === "rejected" && rejectionReason) {
      measurement.rejectionReason = rejectionReason;
    }

    this.measurements.set(measurement.id, measurement);

    this.recordAuditLog({
      hospitalId: measurement.hospitalId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action:
        decision === "verified_offline"
          ? "OFFLINE_READING_VERIFIED"
          : "OFFLINE_READING_REJECTED",
      targetCollection: "measurements",
      targetId: measurement.id,
      metadata: {
        patientId: measurement.patientId,
        decision,
      },
    });

    return measurement;
  }

  public completeMeasurementSession(
    creds: Esp32DeviceCredentials,
    rawBody: unknown
  ): MeasurementSession {
    const device = this.authenticateEsp32Device(creds);
    const body = completeSessionRequestSchema.parse(rawBody);

    const session = this.measurementSessions.get(body.sessionId);
    if (!session) {
      throw new AuthorizationError(
        `Session '${body.sessionId}' not found`,
        "SESSION_NOT_FOUND",
        404
      );
    }

    if (
      session.deviceId !== device.deviceId ||
      session.hospitalId !== device.hospitalId
    ) {
      throw new AuthorizationError(
        "Session does not belong to this device",
        "SESSION_DEVICE_MISMATCH",
        403
      );
    }

    const now = new Date().toISOString();
    session.status = "completed";
    session.completedAt = now;
    this.measurementSessions.set(session.id, session);

    this.recordAuditLog({
      hospitalId: device.hospitalId,
      actorUid: device.deviceId,
      actorRole: "esp32_device",
      action: "SESSION_COMPLETED",
      targetCollection: "measurementSessions",
      targetId: session.id,
      metadata: {
        patientId: session.patientId,
      },
    });

    return session;
  }

  public reportDeviceHeartbeat(
    creds: Esp32DeviceCredentials,
    rawBody: unknown
  ): MonitoringDevice {
    const device = this.authenticateEsp32Device(creds);
    const body = deviceHeartbeatRequestSchema.parse(rawBody);

    if (body.deviceId !== device.deviceId) {
      throw new AuthorizationError(
        "Device ID mismatch in heartbeat payload",
        "DEVICE_ID_MISMATCH",
        403
      );
    }

    const now = new Date().toISOString();
    device.firmwareVersion = body.firmwareVersion;
    device.lastSeenAt = now;
    device.pendingOfflineCount = body.pendingOfflineCount;
    if (typeof body.batteryPct === "number") {
      device.batteryPct = body.batteryPct;
    }
    if (typeof body.wifiRssiDbm === "number") {
      device.wifiRssiDbm = body.wifiRssiDbm;
      device.connectionStatus =
        body.wifiRssiDbm < -80 ? "degraded" : "online";
    } else {
      device.connectionStatus = "online";
    }
    device.updatedAt = now;

    this.devices.set(device.id, device);
    return device;
  }

  /**
   * Simplified Single-Device Demo Upload:
   * Assumes 1 ESP32 device (`dev_esp32_pti_01`) is used by a single demo user (`pat_pti_901a2b3c4d`).
   */
  public recordDirectDemoReading(
    creds: Esp32DeviceCredentials,
    rawInput: {
      heartRateBpm: number;
      spo2Pct: number;
      surfaceTempC: number;
    }
  ): VitalMeasurement {
    const device = this.authenticateEsp32Device(creds);
    const hospital = this.hospitals.get(device.hospitalId);
    const thresholds =
      hospital?.alertThresholds || DEFAULT_HOSPITAL_THRESHOLDS;

    const demoPatient =
      this.patients.get("pat_pti_901a2b3c4d") ||
      Array.from(this.patients.values())[0];

    const evaluation = evaluateVitalMeasurement(
      {
        heartRateBpm: Number(rawInput.heartRateBpm),
        spo2Pct: Number(rawInput.spo2Pct),
        surfaceTempC: Number(rawInput.surfaceTempC),
      },
      thresholds
    );

    const now = new Date().toISOString();
    const measurementId = `meas_demo_${Date.now()}`;

    const measurement: VitalMeasurement = {
      id: measurementId,
      measurementId,
      hospitalId: device.hospitalId,
      patientId: demoPatient.id,
      patientName: demoPatient.fullName,
      patientCodeAtCapture: demoPatient.patientCode,
      sessionId: "sess_demo_direct",
      deviceId: device.deviceId,
      deviceName: device.name,
      heartRateBpm: Number(rawInput.heartRateBpm),
      spo2Pct: Number(rawInput.spo2Pct),
      surfaceTempC: Number(rawInput.surfaceTempC),
      tempSensorType: "MLX90614_SURFACE_IR",
      opticalSensorType: "MAX30102_PROTOTYPE",
      capturedAt: now,
      uploadedAt: now,
      syncStatus: "verified_online",
      validityStatus: evaluation.validityStatus,
      alertLevel: evaluation.alertLevel,
      alertFlags: evaluation.alertFlags,
      createdAt: now,
    };

    this.measurements.set(measurement.id, measurement);

    device.connectionStatus = "online";
    device.lastSeenAt = now;
    device.updatedAt = now;
    this.devices.set(device.id, device);

    return measurement;
  }

  /**
   * Updates the live Online/Offline connectivity status of the single demo ESP32 device.
   */
  public setDemoDeviceConnectionStatus(
    creds: Esp32DeviceCredentials,
    connectionStatus: "online" | "offline"
  ): MonitoringDevice {
    const device = this.authenticateEsp32Device(creds);
    const now = new Date().toISOString();
    device.connectionStatus = connectionStatus;
    if (connectionStatus === "online") {
      device.lastSeenAt = now;
    }
    device.updatedAt = now;
    this.devices.set(device.id, device);
    return device;
  }

  public updateHospitalSettings(
    actor: AuthenticatedActor,
    hospitalId: string,
    rawInput: unknown
  ): Hospital {
    enforceHospitalAccess(actor, hospitalId, "hospital:manage_settings");
    const input = hospitalSettingsSchema.parse(rawInput);
    const hospital = this.hospitals.get(hospitalId);
    if (!hospital) {
      throw new Error(`Hospital '${hospitalId}' not found`);
    }

    const updated: Hospital = {
      ...hospital,
      name: input.name,
      state: input.state,
      lga: input.lga,
      address: input.address,
      ndpaDpoEmail: input.ndpaDpoEmail,
      retentionDays: input.retentionDays,
      alertThresholds: input.alertThresholds,
      updatedAt: new Date().toISOString(),
    };
    this.hospitals.set(hospitalId, updated);

    this.recordAuditLog({
      hospitalId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action: "HOSPITAL_SETTINGS_UPDATED",
      targetCollection: "hospitals",
      targetId: hospitalId,
      metadata: {
        retentionDays: input.retentionDays,
        spo2CriticalPct: input.alertThresholds.spo2CriticalPct,
      },
    });

    return updated;
  }

  public addOrUpdateStaffMember(
    actor: AuthenticatedActor,
    hospitalId: string,
    rawInput: unknown
  ): HospitalMember {
    enforceHospitalAccess(actor, hospitalId, "hospital:manage_staff");
    const input = staffMemberSchema.parse(rawInput);

    if (actor.role !== "super_admin" && input.role === "super_admin") {
      throw new AuthorizationError(
        "Only a Super Admin can grant the super_admin role",
        "ROLE_ESCALATION_FORBIDDEN",
        403
      );
    }

    const now = new Date().toISOString();
    const uid = `usr_${crypto.randomBytes(6).toString("hex")}`;
    const user: AppUser = {
      uid,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      primaryHospitalId: hospitalId,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(uid, user);

    const memberId = `${hospitalId}_${uid}`;
    const member: HospitalMember = {
      id: memberId,
      hospitalId,
      userId: uid,
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      department: input.department,
      active: true,
      assignedBy: actor.uid,
      createdAt: now,
      updatedAt: now,
    };
    this.hospitalMembers.set(memberId, member);

    this.recordAuditLog({
      hospitalId,
      actorUid: actor.uid,
      actorRole: actor.role,
      action: "STAFF_ROLE_UPDATED",
      targetCollection: "hospitalMembers",
      targetId: memberId,
      metadata: {
        assignedRole: input.role,
        department: input.department,
      },
    });

    return member;
  }
}

// Singleton store instance for API routes & server state in local/demo runtime
const globalForStore = globalThis as unknown as {
  __healthOsStore?: HospitalIoTPlatformStore;
  __healthOsStoreVersion?: number;
};

const STORE_VERSION = 3;

export function getPlatformStore(): HospitalIoTPlatformStore {
  if (
    !globalForStore.__healthOsStore ||
    globalForStore.__healthOsStoreVersion !== STORE_VERSION
  ) {
    globalForStore.__healthOsStore = new HospitalIoTPlatformStore(true);
    globalForStore.__healthOsStoreVersion = STORE_VERSION;
  }
  return globalForStore.__healthOsStore;
}
