export const PTI_CLINIC_ID = "hosp_pti_clinic" as const;
export const PTI_CLINIC_NAME = "PTI Clinic" as const;

export type UserRole =
  | "super_admin"
  | "hospital_admin"
  | "doctor"
  | "nurse"
  | "device_operator";

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  hospital_admin: "Hospital Admin",
  doctor: "Doctor",
  nurse: "Nurse",
  device_operator: "Device Operator",
};

export interface VitalAlertThresholds {
  heartRateMinBpm: number;
  heartRateMaxBpm: number;
  spo2MinPct: number;
  spo2CriticalPct: number;
  surfaceTempMinC: number;
  surfaceTempMaxC: number;
}

export interface Hospital {
  id: string;
  name: string;
  code: string;
  state: string;
  lga: string;
  address: string;
  ndpaDpoEmail: string;
  retentionDays: number;
  alertThresholds: VitalAlertThresholds;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  primaryHospitalId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HospitalMember {
  id: string; // `${hospitalId}_${userId}`
  hospitalId: string;
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
  department: string;
  active: boolean;
  assignedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type PatientClinicalStatus =
  | "stable"
  | "attention"
  | "critical"
  | "discharged";

export interface Patient {
  id: string; // Internal Firestore document ID (never equal to patientCode)
  hospitalId: string;
  patientCode: string; // Unique 6-digit numeric keypad code within hospital scope, e.g. "102345"
  fullName: string;
  dateOfBirth: string;
  sex: "male" | "female" | "other";
  ward: string;
  bedNumber: string;
  assignedDoctorId: string;
  assignedDoctorName?: string;
  assignedNurseId: string;
  assignedNurseName?: string;
  status: PatientClinicalStatus;
  consentRecorded: boolean; // NDPA health data processing consent
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export type DeviceLifecycleStatus =
  | "active"
  | "inactive"
  | "maintenance"
  | "revoked";

export type DeviceConnectionStatus = "online" | "offline" | "degraded";

export interface MonitoringDevice {
  id: string; // Internal deviceId, e.g. "dev-esp32-lag-01"
  deviceId: string;
  serialNumber: string;
  macAddress: string;
  hospitalId: string;
  name: string;
  ward: string;
  firmwareVersion: string;
  hardwareRevision: string;
  status: DeviceLifecycleStatus;
  connectionStatus: DeviceConnectionStatus;
  lastSeenAt: string;
  batteryPct?: number;
  wifiRssiDbm?: number;
  pendingOfflineCount: number;
  // Stored only on server-side/Admin SDK; never exposed to client UI
  secretKeyHash?: string;
  createdAt: string;
  updatedAt: string;
}

export type MeasurementSessionStatus =
  | "authorized"
  | "capturing"
  | "completed"
  | "expired"
  | "cancelled";

export interface MeasurementSession {
  id: string;
  sessionId: string;
  hospitalId: string;
  patientId: string;
  patientName?: string;
  patientCode: string;
  deviceId: string;
  deviceName?: string;
  operatorId: string;
  operatorName?: string;
  status: MeasurementSessionStatus;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
}

export type MeasurementSyncStatus =
  | "verified_online"
  | "pending_offline"
  | "verified_offline"
  | "rejected";

export type MeasurementValidityStatus =
  | "valid"
  | "artifact_suspected"
  | "uncalibrated_warning";

export type VitalAlertLevel = "normal" | "warning" | "high_priority";

export interface VitalMeasurement {
  id: string; // Deterministic idempotency measurementId from ESP32 or session
  measurementId: string;
  hospitalId: string;
  patientId: string;
  patientName?: string;
  patientCodeAtCapture: string;
  sessionId: string;
  deviceId: string;
  deviceName?: string;
  heartRateBpm: number; // MAX30102 prototype pulse rate in BPM
  spo2Pct: number; // MAX30102 prototype SpO2 %
  surfaceTempC: number; // MLX90614 infrared surface temperature in °C (NOT core body temp)
  tempSensorType: "MLX90614_SURFACE_IR";
  opticalSensorType: "MAX30102_PROTOTYPE";
  capturedAt: string;
  uploadedAt: string;
  syncStatus: MeasurementSyncStatus;
  validityStatus: MeasurementValidityStatus;
  alertLevel: VitalAlertLevel;
  alertFlags: string[];
  verifiedByUid?: string;
  verifiedAt?: string;
  rejectionReason?: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  hospitalId: string;
  actorUid: string;
  actorRole: UserRole | "esp32_device";
  action:
    | "PATIENT_REGISTERED"
    | "PATIENT_UPDATED"
    | "DEVICE_REGISTERED"
    | "DEVICE_STATUS_CHANGED"
    | "SESSION_AUTHORIZED"
    | "SESSION_COMPLETED"
    | "MEASUREMENT_UPLOADED"
    | "OFFLINE_BATCH_SYNCED"
    | "OFFLINE_READING_VERIFIED"
    | "OFFLINE_READING_REJECTED"
    | "STAFF_ROLE_UPDATED"
    | "HOSPITAL_SETTINGS_UPDATED"
    | "UNAUTHORIZED_ACCESS_BLOCKED";
  targetCollection:
    | "hospitals"
    | "users"
    | "hospitalMembers"
    | "patients"
    | "devices"
    | "measurementSessions"
    | "measurements";
  targetId: string;
  // Never store raw patient full names or unnecessary PII in audit logs (NDPA minimization)
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}
