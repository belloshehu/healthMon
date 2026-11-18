import { describe, it, expect, beforeEach } from "vitest";
import { HospitalIoTPlatformStore } from "@/lib/domain/iotBackendService";
import { DEV_DEVICE_SECRETS } from "@/lib/domain/seedData";
import { AuthenticatedActor } from "@/lib/auth/rbac";
import { PTI_CLINIC_ID } from "@/types/models";

describe("HealthOS IoT — PTI Clinic Health Monitoring Platform Test Suite", () => {
  let store: HospitalIoTPlatformStore;

  const ptiNurse: AuthenticatedActor = {
    uid: "usr_nurse_pti_1",
    email: "nurse.adeyemi@pticlinic.edu.ng",
    role: "nurse",
    hospitalId: PTI_CLINIC_ID,
    active: true,
  };

  const ptiAdmin: AuthenticatedActor = {
    uid: "usr_hosp_admin_pti",
    email: "admin@pticlinic.edu.ng",
    role: "hospital_admin",
    hospitalId: PTI_CLINIC_ID,
    active: true,
  };

  const ptiOperator: AuthenticatedActor = {
    uid: "usr_operator_pti_1",
    email: "operator.musa@pticlinic.edu.ng",
    role: "device_operator",
    hospitalId: PTI_CLINIC_ID,
    active: true,
  };

  const validPtiEsp32 = {
    deviceId: "dev_esp32_pti_01",
    deviceSecret: DEV_DEVICE_SECRETS["dev_esp32_pti_01"],
    firebaseUid: "anon_uid_esp32_01",
  };

  beforeEach(() => {
    store = new HospitalIoTPlatformStore(true);
  });

  describe("1. Patient-Code Uniqueness & Internal ID Separation (PTI Clinic)", () => {
    it("generates a unique 6-digit numeric patient code separate from internal Firestore ID", () => {
      const patient = store.registerPatient(ptiNurse, {
        hospitalId: PTI_CLINIC_ID,
        fullName: "Chidinma Okafor (Synthetic)",
        dateOfBirth: "1991-06-15",
        sex: "female",
        ward: "Medical Ward B",
        bedNumber: "B-04",
        assignedDoctorId: "usr_doctor_pti_1",
        assignedNurseId: "usr_nurse_pti_1",
        status: "stable",
        consentRecorded: true,
      });

      expect(patient.hospitalId).toBe(PTI_CLINIC_ID);
      expect(patient.patientCode).toMatch(/^\d{6}$/);
      expect(patient.id).toMatch(/^pat_[a-f0-9]{20}$/);
      expect(patient.id).not.toBe(patient.patientCode);
    });

    it("prevents reusing an already issued patient code in PTI Clinic", () => {
      // "102345" is already assigned in PTI Clinic seed data
      expect(() =>
        store.registerPatient(
          ptiNurse,
          {
            hospitalId: PTI_CLINIC_ID,
            fullName: "Duplicate Code Test",
            dateOfBirth: "1985-03-10",
            sex: "male",
            ward: "Ward A",
            bedNumber: "A-01",
            assignedDoctorId: "usr_doctor_pti_1",
            assignedNurseId: "usr_nurse_pti_1",
            status: "stable",
            consentRecorded: true,
          },
          "102345"
        )
      ).toThrow(/already been issued/);
    });

    it("generates 150 consecutive patient codes in PTI Clinic without a single collision", () => {
      const seenCodes = new Set<string>();
      for (let i = 0; i < 150; i++) {
        const p = store.registerPatient(ptiNurse, {
          hospitalId: PTI_CLINIC_ID,
          fullName: `Synthetic Patient #${i}`,
          dateOfBirth: "1980-01-01",
          sex: "other",
          ward: "General Ward",
          bedNumber: `G-${i}`,
          assignedDoctorId: "usr_doctor_pti_1",
          assignedNurseId: "usr_nurse_pti_1",
          status: "stable",
          consentRecorded: true,
        });
        expect(seenCodes.has(p.patientCode)).toBe(false);
        seenCodes.add(p.patientCode);
      }
      expect(seenCodes.size).toBe(150);
    });
  });

  describe("2. Single-Clinic (PTI Clinic) Enforcement & RBAC", () => {
    it("supports only PTI Clinic and rejects requests targeting any other clinic", () => {
      expect(store.hospitals.size).toBe(1);
      expect(store.hospitals.get(PTI_CLINIC_ID)?.name).toBe("PTI Clinic");

      expect(() =>
        store.listHospitalPatients(ptiNurse, "hosp_other_unsupported_clinic")
      ).toThrow(/Only PTI Clinic \('hosp_pti_clinic'\) is supported/);
    });

    it("rejects anonymous Firebase users attempting to access PTI Clinic patient records directly", () => {
      expect(() =>
        store.listHospitalPatients(
          {
            ...ptiNurse,
            isAnonymous: true,
          },
          PTI_CLINIC_ID
        )
      ).toThrow(/Anonymous Firebase accounts are not permitted/);
    });

    it("enforces RBAC so a Device Operator cannot register patients or verify offline readings", () => {
      expect(() =>
        store.registerPatient(ptiOperator, {
          hospitalId: PTI_CLINIC_ID,
          fullName: "Unauthorized Operator Patient",
          dateOfBirth: "1990-01-01",
          sex: "male",
          ward: "Ward 1",
          bedNumber: "01",
          assignedDoctorId: "usr_doctor_pti_1",
          assignedNurseId: "usr_nurse_pti_1",
          status: "stable",
          consentRecorded: true,
        })
      ).toThrow(/Role 'device_operator' is not authorized/);
    });
  });

  describe("3. ESP32 Device Authentication & Authorization", () => {
    it("rejects anonymous Firebase sign-in alone without registered device credentials", () => {
      expect(() =>
        store.verifyPatientCodeAndCreateSession(
          {
            deviceId: "dev_esp32_pti_01",
            deviceSecret: "",
            firebaseUid: "anon_only_uid",
            isAnonymousAuthOnly: true,
          },
          {
            deviceId: "dev_esp32_pti_01",
            patientCode: "102345",
          }
        )
      ).toThrow(/Anonymous Firebase sign-in alone is not trusted/);
    });

    it("rejects ESP32 requests with an invalid HMAC device secret and records a security audit log", () => {
      const initialAuditCount = store.auditLogs.length;

      expect(() =>
        store.verifyPatientCodeAndCreateSession(
          {
            deviceId: "dev_esp32_pti_01",
            deviceSecret: "forged_wrong_device_secret_123456",
            firebaseUid: "anon_uid_esp32_01",
          },
          {
            deviceId: "dev_esp32_pti_01",
            patientCode: "102345",
          }
        )
      ).toThrow(/Invalid device cryptographic secret/);

      expect(store.auditLogs.length).toBe(initialAuditCount + 1);
      expect(store.auditLogs[0].action).toBe("UNAUTHORIZED_ACCESS_BLOCKED");
    });

    it("blocks deactivated or revoked ESP32 devices from starting sessions or uploading readings", () => {
      store.updateDeviceStatus(ptiAdmin, "dev_esp32_pti_01", "inactive");

      expect(() =>
        store.verifyPatientCodeAndCreateSession(validPtiEsp32, {
          deviceId: "dev_esp32_pti_01",
          patientCode: "102345",
        })
      ).toThrow(/currently 'inactive' and not authorized/);
    });
  });

  describe("4. Measurement Sessions, Vital Uploads & Reassignment Prevention", () => {
    it("verifies patient keypad code, creates an authorized session, and uploads MAX30102/MLX90614 vitals", () => {
      const { session, patientDisplay } =
        store.verifyPatientCodeAndCreateSession(validPtiEsp32, {
          deviceId: "dev_esp32_pti_01",
          patientCode: "102345",
          operatorId: "usr_nurse_pti_1",
        });

      expect(session.status).toBe("authorized");
      expect(session.patientId).toBe("pat_pti_901a2b3c4d");
      expect(patientDisplay.patientCode).toBe("102345");

      const { measurement, deduplicated } = store.uploadMeasurement(
        validPtiEsp32,
        {
          measurementId: "meas_esp32_live_test_001",
          sessionId: session.sessionId,
          deviceId: "dev_esp32_pti_01",
          heartRateBpm: 82,
          spo2Pct: 98,
          surfaceTempC: 36.4,
          capturedAt: new Date().toISOString(),
        }
      );

      expect(deduplicated).toBe(false);
      expect(measurement.patientId).toBe("pat_pti_901a2b3c4d");
      expect(measurement.tempSensorType).toBe("MLX90614_SURFACE_IR");
      expect(measurement.opticalSensorType).toBe("MAX30102_PROTOTYPE");
      expect(measurement.syncStatus).toBe("verified_online");
    });

    it("enforces idempotency on duplicate measurement uploads and forbids reassigning measurementId to another session/patient", () => {
      const { session: s1 } = store.verifyPatientCodeAndCreateSession(
        validPtiEsp32,
        {
          deviceId: "dev_esp32_pti_01",
          patientCode: "102345",
        }
      );

      const payload = {
        measurementId: "meas_idempotent_999",
        sessionId: s1.sessionId,
        deviceId: "dev_esp32_pti_01",
        heartRateBpm: 78,
        spo2Pct: 97,
        surfaceTempC: 36.3,
        capturedAt: new Date().toISOString(),
      };

      const first = store.uploadMeasurement(validPtiEsp32, payload);
      expect(first.deduplicated).toBe(false);

      // Safe network retry with identical measurementId and sessionId returns deduplicated: true
      const retry = store.uploadMeasurement(validPtiEsp32, payload);
      expect(retry.deduplicated).toBe(true);
      expect(retry.measurement.id).toBe(first.measurement.id);

      // Attempt to reuse measurementId on a different patient's session MUST fail
      const { session: s2 } = store.verifyPatientCodeAndCreateSession(
        validPtiEsp32,
        {
          deviceId: "dev_esp32_pti_01",
          patientCode: "389412",
        }
      );

      expect(() =>
        store.uploadMeasurement(validPtiEsp32, {
          ...payload,
          sessionId: s2.sessionId,
        })
      ).toThrow(/cannot be reassigned/);

      // Direct reassignment helper also throws
      expect(() =>
        store.reassignMeasurementPatient(
          ptiAdmin,
          "meas_idempotent_999",
          "pat_pti_703c4d5e6f"
        )
      ).toThrow(/Immutable patient association violation/);
    });
  });

  describe("5. Offline Synchronization, Duplicate Prevention & Clinical Verification", () => {
    it("synchronizes offline batches as pending_offline, deduplicates retries, and blocks patient reassignment", () => {
      const batchTime = new Date().toISOString();
      const syncResponse = store.syncOfflineMeasurements(validPtiEsp32, {
        deviceId: "dev_esp32_pti_01",
        firmwareVersion: "v2.4.2-esp32-ard",
        readings: [
          {
            measurementId: "offline_q_item_101",
            patientCode: "102345",
            heartRateBpm: 88,
            spo2Pct: 96,
            surfaceTempC: 36.5,
            capturedAt: batchTime,
          },
          {
            measurementId: "offline_q_item_102_bad_code",
            patientCode: "987654", // Unknown patient code
            heartRateBpm: 90,
            spo2Pct: 97,
            surfaceTempC: 36.6,
            capturedAt: batchTime,
          },
        ],
      });

      expect(syncResponse.acceptedCount).toBe(1);
      expect(syncResponse.rejectedCount).toBe(1);
      expect(syncResponse.results[0].status).toBe("accepted_pending");
      expect(syncResponse.results[1].status).toBe("rejected");

      const stored = store.measurements.get("offline_q_item_101");
      expect(stored?.syncStatus).toBe("pending_offline");
      expect(stored?.patientCodeAtCapture).toBe("102345");

      // Re-sending the same offline item is idempotently ignored
      const retrySync = store.syncOfflineMeasurements(validPtiEsp32, {
        deviceId: "dev_esp32_pti_01",
        firmwareVersion: "v2.4.2-esp32-ard",
        readings: [
          {
            measurementId: "offline_q_item_101",
            patientCode: "102345",
            heartRateBpm: 88,
            spo2Pct: 96,
            surfaceTempC: 36.5,
            capturedAt: batchTime,
          },
        ],
      });
      expect(retrySync.duplicateCount).toBe(1);
      expect(retrySync.results[0].status).toBe("duplicate_ignored");

      // Attempting to re-sync offline_q_item_101 under a DIFFERENT patient code (389412) is rejected!
      const hijackAttempt = store.syncOfflineMeasurements(validPtiEsp32, {
        deviceId: "dev_esp32_pti_01",
        firmwareVersion: "v2.4.2-esp32-ard",
        readings: [
          {
            measurementId: "offline_q_item_101",
            patientCode: "389412",
            heartRateBpm: 88,
            spo2Pct: 96,
            surfaceTempC: 36.5,
            capturedAt: batchTime,
          },
        ],
      });
      expect(hijackAttempt.rejectedCount).toBe(1);
      expect(hijackAttempt.results[0].errorCode).toBe(
        "PATIENT_REASSIGNMENT_FORBIDDEN"
      );

      // Nurse verifies the pending offline reading
      const verified = store.verifyOfflineMeasurement(
        ptiNurse,
        "offline_q_item_101",
        "verified_offline"
      );
      expect(verified.syncStatus).toBe("verified_offline");
      expect(verified.patientId).toBe("pat_pti_901a2b3c4d");
    });
  });
});
