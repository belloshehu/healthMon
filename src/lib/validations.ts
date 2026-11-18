import { z } from "zod";

export const userRoleSchema = z.enum([
  "super_admin",
  "hospital_admin",
  "doctor",
  "nurse",
  "device_operator",
]);

export const patientCodeSchema = z
  .string()
  .regex(/^\d{6}$/, "Patient keypad code must be an exact 6-digit number (e.g., 102345)");

export const patientRegistrationSchema = z.object({
  hospitalId: z.literal("hosp_pti_clinic").default("hosp_pti_clinic"),
  fullName: z
    .string()
    .min(2, "Full name must be at least 2 characters")
    .max(150, "Full name must not exceed 150 characters"),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format"),
  sex: z.enum(["male", "female", "other"]),
  ward: z.string().min(1, "Ward is required").max(80),
  bedNumber: z.string().min(1, "Bed number is required").max(30),
  assignedDoctorId: z.string().min(1, "Assigned doctor is required"),
  assignedNurseId: z.string().min(1, "Assigned nurse is required"),
  status: z.enum(["stable", "attention", "critical", "discharged"]).default("stable"),
  consentRecorded: z
    .boolean()
    .refine((val) => val === true, {
      message: "Patient data processing consent is required under the Nigeria Data Protection Act (NDPA)",
    }),
});

export const deviceRegistrationSchema = z.object({
  hospitalId: z.literal("hosp_pti_clinic").default("hosp_pti_clinic"),
  serialNumber: z
    .string()
    .min(4, "Serial number must be at least 4 characters")
    .max(80)
    .regex(/^[A-Za-z0-9-_]+$/, "Serial number must be alphanumeric with hyphens/underscores"),
  macAddress: z
    .string()
    .regex(
      /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/,
      "MAC address must be in XX:XX:XX:XX:XX:XX format"
    ),
  name: z.string().min(2, "Device name is required").max(120),
  ward: z.string().min(1, "Assigned ward is required").max(80),
  firmwareVersion: z
    .string()
    .min(1, "Firmware version is required")
    .max(40)
    .default("v2.4.0-esp32"),
  hardwareRevision: z.string().default("ESP32-WROOM-32-REV1"),
});

export const esp32AuthHeaderSchema = z.object({
  deviceId: z.string().min(3, "Device ID is required"),
  deviceSecret: z.string().min(16, "Device secret token is required"),
  firebaseUid: z.string().min(1, "Firebase Auth UID is required"),
});

export const verifyPatientCodeRequestSchema = z.object({
  deviceId: z.string().min(3),
  patientCode: patientCodeSchema,
  operatorId: z.string().optional().default("keypad_operator"),
});

export const uploadMeasurementRequestSchema = z.object({
  measurementId: z
    .string()
    .min(8, "Unique measurementId is required for idempotency")
    .max(120),
  sessionId: z.string().min(4, "Authorized sessionId is required"),
  deviceId: z.string().min(3, "Device ID is required"),
  heartRateBpm: z
    .number()
    .min(25, "Heart rate reading out of physiological sensor range (25-250 BPM)")
    .max(250, "Heart rate reading out of physiological sensor range (25-250 BPM)"),
  spo2Pct: z
    .number()
    .min(50, "SpO2 reading out of sensor range (50-100%)")
    .max(100, "SpO2 reading out of sensor range (50-100%)"),
  surfaceTempC: z
    .number()
    .min(25.0, "Surface temperature out of MLX90614 range (25.0-45.0 °C)")
    .max(45.0, "Surface temperature out of MLX90614 range (25.0-45.0 °C)"),
  capturedAt: z.string().datetime({ message: "capturedAt must be a valid ISO-8601 timestamp" }),
});

export const offlineMeasurementItemSchema = z.object({
  measurementId: z
    .string()
    .min(8, "Unique measurementId is required to prevent duplicates")
    .max(120),
  patientCode: patientCodeSchema,
  heartRateBpm: z.number().min(25).max(250),
  spo2Pct: z.number().min(50).max(100),
  surfaceTempC: z.number().min(25.0).max(45.0),
  capturedAt: z.string().datetime(),
  operatorId: z.string().optional().default("offline_keypad_operator"),
});

export const offlineBatchSyncRequestSchema = z.object({
  deviceId: z.string().min(3),
  firmwareVersion: z.string().min(1),
  readings: z
    .array(offlineMeasurementItemSchema)
    .min(1, "At least one offline reading is required")
    .max(50, "Maximum 50 readings per synchronization batch"),
});

export const completeSessionRequestSchema = z.object({
  sessionId: z.string().min(4),
  deviceId: z.string().min(3),
});

export const deviceHeartbeatRequestSchema = z.object({
  deviceId: z.string().min(3),
  firmwareVersion: z.string().min(1).max(40),
  wifiRssiDbm: z.number().min(-120).max(0).optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  pendingOfflineCount: z.number().int().min(0).default(0),
});

export const hospitalSettingsSchema = z.object({
  name: z.string().min(2).max(150),
  state: z.string().min(2).max(60),
  lga: z.string().min(2).max(80),
  address: z.string().min(5).max(300),
  ndpaDpoEmail: z.string().email("Valid Data Protection Officer email is required"),
  retentionDays: z.number().int().min(30).max(3650),
  alertThresholds: z.object({
    heartRateMinBpm: z.number().min(30).max(90),
    heartRateMaxBpm: z.number().min(95).max(220),
    spo2MinPct: z.number().min(85).max(98),
    spo2CriticalPct: z.number().min(70).max(94),
    surfaceTempMinC: z.number().min(30).max(36.5),
    surfaceTempMaxC: z.number().min(36.5).max(42),
  }),
});

export const staffMemberSchema = z.object({
  email: z.string().email("Valid staff email is required"),
  displayName: z.string().min(2, "Display name is required").max(120),
  role: userRoleSchema,
  department: z.string().min(2, "Department is required").max(100),
});
