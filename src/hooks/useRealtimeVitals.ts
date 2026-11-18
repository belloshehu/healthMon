"use client";

import { useEffect, useState, useCallback } from "react";
import { signInAnonymously } from "firebase/auth";
import {
  collectionGroup,
  doc,
  onSnapshot,
  setDoc,
} from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";
import { VitalAlertLevel, VitalMeasurement } from "@/types/models";

export const DEVICE_ID = "dev_esp32_pti_01";
export const HEARTBEAT_TIMEOUT_MS = 60_000; // 60-second online timeout

export interface FirmwareReading extends VitalMeasurement {
  hasHr: boolean;
  hasSpo2: boolean;
  hasTemp: boolean;
  anonymousUid?: string;
}

export interface Esp32DeviceState {
  deviceId: string;
  serialNumber: string;
  status: "online" | "offline";
  lastSeenMs: number;
  anonymousUid?: string;
}

function evaluatePartialReadingAlert(reading: {
  heartRate?: number;
  spo2?: number;
  temperatureC?: number;
}): VitalAlertLevel {
  let level: VitalAlertLevel = "normal";

  if (reading.heartRate !== undefined) {
    if (reading.heartRate > 135 || reading.heartRate < 40) {
      return "high_priority";
    }
    if (reading.heartRate > 110 || reading.heartRate < 50) {
      level = "warning";
    }
  }

  if (reading.spo2 !== undefined) {
    if (reading.spo2 < 90) {
      return "high_priority";
    }
    if (reading.spo2 < 94) {
      level = "warning";
    }
  }

  if (reading.temperatureC !== undefined) {
    if (reading.temperatureC >= 38.5) {
      return "high_priority";
    }
    if (reading.temperatureC > 37.5 || reading.temperatureC < 34.0) {
      level = "warning";
    }
  }

  return level;
}

/**
 * Parses a Firestore document written by the ESP32 firmware at:
 * `deviceReadings/{uid}/measurements/{uploadId}`
 *
 * Firmware fields:
 * - deviceId: "dev_esp32_pti_01"
 * - anonymousUid: string
 * - measurementType: "prototype"
 * - uploadedBy: "esp32"
 * - heartRate (int), heartRateEpoch (int seconds)
 * - spo2 (int), spo2Epoch (int seconds)
 * - temperatureC (double), temperatureEpoch (int seconds)
 */
function parseFirmwareMeasurementDoc(
  docId: string,
  raw: Record<string, unknown>
): FirmwareReading {
  const rawHr = raw.heartRate ?? raw.heartRateBpm;
  const rawSpo2 = raw.spo2 ?? raw.spo2Pct;
  const rawTemp = raw.temperatureC ?? raw.surfaceTempC;

  const hasHr = typeof rawHr === "number" && !Number.isNaN(rawHr);
  const hasSpo2 = typeof rawSpo2 === "number" && !Number.isNaN(rawSpo2);
  const hasTemp = typeof rawTemp === "number" && !Number.isNaN(rawTemp);

  const hr = hasHr ? Number(rawHr) : 0;
  const spo2 = hasSpo2 ? Number(rawSpo2) : 0;
  const temp = hasTemp ? Number(rawTemp) : 0;

  // Firmware sends Unix epoch in seconds (`heartRateEpoch`, `spo2Epoch`, `temperatureEpoch`)
  const epochSec = Math.max(
    Number(raw.heartRateEpoch || 0),
    Number(raw.spo2Epoch || 0),
    Number(raw.temperatureEpoch || 0)
  );

  const capturedAtIso =
    epochSec > 1700000000
      ? new Date(epochSec * 1000).toISOString()
      : typeof raw.capturedAt === "string"
      ? raw.capturedAt
      : new Date().toISOString();

  const alertLevel = evaluatePartialReadingAlert({
    heartRate: hasHr ? hr : undefined,
    spo2: hasSpo2 ? spo2 : undefined,
    temperatureC: hasTemp ? temp : undefined,
  });

  return {
    id: docId,
    measurementId: docId,
    hospitalId: "hosp_pti_clinic",
    patientId: "pat_pti_901a2b3c4d",
    patientName: "PTI Clinic User",
    patientCodeAtCapture: "102345",
    sessionId: "esp32_direct",
    deviceId: String(raw.deviceId || DEVICE_ID),
    anonymousUid:
      typeof raw.anonymousUid === "string" ? raw.anonymousUid : undefined,
    heartRateBpm: hr,
    spo2Pct: spo2,
    surfaceTempC: temp,
    hasHr,
    hasSpo2,
    hasTemp,
    tempSensorType: "MLX90614_SURFACE_IR",
    opticalSensorType: "MAX30102_PROTOTYPE",
    capturedAt: capturedAtIso,
    uploadedAt: capturedAtIso,
    syncStatus: "verified_online",
    validityStatus: "valid",
    alertLevel,
    alertFlags: [],
    createdAt: capturedAtIso,
  };
}

export function useRealtimeVitals() {
  const [device, setDevice] = useState<Esp32DeviceState>({
    deviceId: DEVICE_ID,
    serialNumber: "ESP32-PTI-001",
    status: "online",
    lastSeenMs: Date.now(),
  });
  const [readings, setReadings] = useState<FirmwareReading[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [firestoreConnected, setFirestoreConnected] = useState<boolean>(false);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  // 1-second clock to evaluate the 60-second heartbeat timeout
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const { auth, db } = getFirebaseClient();
    let unsubMeasurements: (() => void) | undefined;
    let unsubDevice: (() => void) | undefined;
    let cancelled = false;

    async function subscribe() {
      try {
        if (!auth.currentUser) {
          await signInAnonymously(auth).catch(() => {
            // Proceed even if anonymous sign-in is not yet enabled in console
          });
        }
        if (cancelled) return;

        // 1. Listen to `/devices/dev_esp32_pti_01` for heartbeat updates
        const deviceDocRef = doc(db, "devices", DEVICE_ID);
        unsubDevice = onSnapshot(
          deviceDocRef,
          (snap) => {
            setFirestoreConnected(true);
            if (snap.exists()) {
              const data = snap.data();
              const epochSec = Number(data.lastSeenEpoch || 0);
              const seenMs =
                epochSec > 1700000000
                  ? epochSec * 1000
                  : typeof data.lastSeenAt === "string"
                  ? new Date(data.lastSeenAt).getTime()
                  : Date.now();

              setDevice((prev) => ({
                ...prev,
                status: data.status === "offline" ? "offline" : "online",
                lastSeenMs: Math.max(prev.lastSeenMs, seenMs),
                anonymousUid:
                  typeof data.anonymousUid === "string"
                    ? data.anonymousUid
                    : prev.anonymousUid,
              }));
            }
          },
          () => {
            // Ignore device doc listener errors if rules not deployed yet
          }
        );

        // 2. Listen to `collectionGroup(db, "measurements")` matching the ESP32 firmware path:
        //    `deviceReadings/{uid}/measurements/{lastUploadId}` without `where()` so no custom COLLECTION_GROUP_ASC index is required
        const measurementsQuery = collectionGroup(db, "measurements");

        unsubMeasurements = onSnapshot(
          measurementsQuery,
          (snapshot) => {
            setFirestoreConnected(true);
            setFirestoreError(null);
            const parsed = snapshot.docs
              .filter((d) => {
                const docDeviceId = d.data()?.deviceId;
                return !docDeviceId || docDeviceId === DEVICE_ID;
              })
              .map((d) =>
                parseFirmwareMeasurementDoc(
                  d.id,
                  d.data() as Record<string, unknown>
                )
              )
              .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

            setReadings(parsed);

            if (parsed.length > 0) {
              const newestMs = new Date(parsed[0].capturedAt).getTime();
              if (!Number.isNaN(newestMs)) {
                setDevice((prev) => ({
                  ...prev,
                  lastSeenMs: Math.max(prev.lastSeenMs, newestMs),
                  anonymousUid: parsed[0].anonymousUid || prev.anonymousUid,
                }));
              }
            }
            setIsLoading(false);
          },
          (err) => {
            setFirestoreError(err.message);
            setIsLoading(false);
          }
        );
      } catch (err: unknown) {
        setFirestoreError(
          err instanceof Error ? err.message : "Failed to connect to Firestore"
        );
        setIsLoading(false);
      }
    }

    subscribe();

    return () => {
      cancelled = true;
      unsubMeasurements?.();
      unsubDevice?.();
    };
  }, []);

  /**
   * Writes a reading using the EXACT same Firestore path and field structure as `uploadReading()` in the ESP32 Arduino sketch:
   * `deviceReadings/{uid}/measurements/{uploadId}`
   */
  const pushFirmwareReading = useCallback(
    async (input: {
      heartRate?: number;
      spo2?: number;
      temperatureC?: number;
    }) => {
      const { auth, db } = getFirebaseClient();
      if (!auth.currentUser) {
        await signInAnonymously(auth).catch(() => {});
      }
      const uid = auth.currentUser?.uid || "sim_anon_uid";
      const nowMs = Date.now();
      const nowEpochSec = Math.floor(nowMs / 1000);
      const uploadId = `${DEVICE_ID}_${nowMs.toString(16)}`;

      const firestorePayload: Record<string, unknown> = {
        deviceId: DEVICE_ID,
        anonymousUid: uid,
        measurementType: "prototype",
        uploadedBy: "esp32",
      };

      if (input.heartRate !== undefined) {
        firestorePayload.heartRate = Math.round(input.heartRate);
        firestorePayload.heartRateEpoch = nowEpochSec;
      }
      if (input.spo2 !== undefined) {
        firestorePayload.spo2 = Math.round(input.spo2);
        firestorePayload.spo2Epoch = nowEpochSec;
      }
      if (input.temperatureC !== undefined) {
        firestorePayload.temperatureC = Number(input.temperatureC.toFixed(1));
        firestorePayload.temperatureEpoch = nowEpochSec;
      }

      // Optimistic UI update
      const optimisticRecord = parseFirmwareMeasurementDoc(
        uploadId,
        firestorePayload
      );
      setReadings((prev) => [optimisticRecord, ...prev]);
      setDevice((prev) => ({
        ...prev,
        status: "online",
        lastSeenMs: nowMs,
        anonymousUid: uid,
      }));
      setNowMs(nowMs);

      await Promise.all([
        setDoc(
          doc(db, "deviceReadings", uid, "measurements", uploadId),
          firestorePayload,
          { merge: true }
        ),
        setDoc(
          doc(db, "devices", DEVICE_ID),
          {
            deviceId: DEVICE_ID,
            anonymousUid: uid,
            status: "online",
            lastSeenEpoch: nowEpochSec,
          },
          { merge: true }
        ),
      ]);
    },
    []
  );

  /**
   * Updates `/devices/dev_esp32_pti_01` status ("online" | "offline") and `lastSeenEpoch` in Firestore.
   */
  const setDeviceStatus = useCallback(
    async (nextStatus: "online" | "offline") => {
      const { auth, db } = getFirebaseClient();
      const uid = auth.currentUser?.uid || "sim_anon_uid";
      const nowMs = Date.now();
      const nowEpochSec = Math.floor(nowMs / 1000);

      setDevice((prev) => ({
        ...prev,
        status: nextStatus,
        lastSeenMs: nextStatus === "online" ? nowMs : prev.lastSeenMs,
      }));
      setNowMs(nowMs);

      await setDoc(
        doc(db, "devices", DEVICE_ID),
        {
          deviceId: DEVICE_ID,
          anonymousUid: uid,
          status: nextStatus,
          ...(nextStatus === "online" ? { lastSeenEpoch: nowEpochSec } : {}),
        },
        { merge: true }
      );
    },
    []
  );

  const secondsSinceLastSeen = Math.max(
    0,
    Math.floor((nowMs - device.lastSeenMs) / 1000)
  );
  const isTimedOut = nowMs - device.lastSeenMs >= HEARTBEAT_TIMEOUT_MS;
  const isOnline = device.status === "online" && !isTimedOut;

  // Compute the most recent valid value for each of the 3 parameters (supporting partial uploads!)
  const latestHrReading = readings.find((r) => r.hasHr);
  const latestSpo2Reading = readings.find((r) => r.hasSpo2);
  const latestTempReading = readings.find((r) => r.hasTemp);

  return {
    device,
    readings,
    latestHr: latestHrReading?.heartRateBpm,
    latestSpo2: latestSpo2Reading?.spo2Pct,
    latestTemp: latestTempReading?.surfaceTempC,
    isOnline,
    isTimedOut,
    secondsSinceLastSeen,
    isLoading,
    firestoreConnected,
    firestoreError,
    pushFirmwareReading,
    setDeviceStatus,
  };
}
