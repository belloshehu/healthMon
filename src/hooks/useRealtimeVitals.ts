"use client";

import { useEffect, useState, useCallback } from "react";
import { signInAnonymously } from "firebase/auth";
import {
  collectionGroup,
  doc,
  onSnapshot,
  setDoc,
} from "firebase/firestore";
import {
  ref,
  onValue,
  update,
  serverTimestamp,
} from "firebase/database";
import { getFirebaseClient } from "@/lib/firebase/client";
import { VitalAlertLevel, VitalMeasurement } from "@/types/models";

export const DEVICE_ID = "dev_esp32_pti_01";
export const HEARTBEAT_TIMEOUT_MS = 30_000; // 30-second offline timeout matching firmware HEARTBEAT_INTERVAL

export interface FirmwareReading extends VitalMeasurement {
  hasHr: boolean;
  hasSpo2: boolean;
  hasTemp: boolean;
  anonymousUid?: string;
}

export interface Esp32DeviceState {
  deviceId: string;
  status: "online" | "offline";
  lastSeenMs: number;
  uptimeSeconds?: number;
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
    status: "offline",
    lastSeenMs: 0,
  });
  const [readings, setReadings] = useState<FirmwareReading[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [firestoreConnected, setFirestoreConnected] = useState<boolean>(false);
  const [rtdbConnected, setRtdbConnected] = useState<boolean>(false);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState<number>(0);

  // 1-second clock to evaluate the 30-second heartbeat timeout
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const { auth, db, rtdb } = getFirebaseClient();
    let unsubMeasurements: (() => void) | undefined;
    let unsubRtdbDevice: (() => void) | undefined;
    let unsubOffset: (() => void) | undefined;
    let cancelled = false;

    async function subscribe() {
      try {
        if (!auth.currentUser) {
          await signInAnonymously(auth).catch(() => {});
        }
        if (cancelled) return;

        // 1. Track Firebase Realtime Database server clock offset so `.sv: "timestamp"` is compared without local clock skew
        unsubOffset = onValue(
          ref(rtdb, ".info/serverTimeOffset"),
          (snap) => {
            if (snap.exists()) {
              setServerTimeOffsetMs(Number(snap.val()) || 0);
            }
          }
        );

        // 2. Listen to Firebase Realtime Database `/device` updated every 30s by `sendHeartbeat()` in firmware
        unsubRtdbDevice = onValue(
          ref(rtdb, "device"),
          (snap) => {
            setRtdbConnected(true);
            if (snap.exists()) {
              const val = snap.val();
              const rawLastSeen = Number(val.lastSeen || 0);
              // Support both ms (.sv: "timestamp") and seconds
              const seenMs =
                rawLastSeen > 0 && rawLastSeen < 10_000_000_000
                  ? rawLastSeen * 1000
                  : rawLastSeen;

              setDevice((prev) => ({
                ...prev,
                deviceId: val.deviceId || DEVICE_ID,
                status: val.status === "online" ? "online" : "offline",
                lastSeenMs: seenMs,
                uptimeSeconds:
                  val.uptimeSeconds !== undefined
                    ? Number(val.uptimeSeconds)
                    : prev.uptimeSeconds,
              }));
              setNowMs(Date.now());
            }
          },
          () => {
            // Ignore RTDB read error if rules not yet deployed
          }
        );

        // 3. Listen to Cloud Firestore `collectionGroup(db, "measurements")` for `uploadReading()` documents
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
            setIsLoading(false);
          },
          (err) => {
            setFirestoreError(err.message);
            setIsLoading(false);
          }
        );
      } catch (err: unknown) {
        setFirestoreError(
          err instanceof Error ? err.message : "Failed to connect to Firebase"
        );
        setIsLoading(false);
      }
    }

    subscribe();

    return () => {
      cancelled = true;
      unsubMeasurements?.();
      unsubRtdbDevice?.();
      unsubOffset?.();
    };
  }, []);

  /**
   * Simulates `uploadReading()` (Firestore) + `sendHeartbeat()` (Realtime DB `/device`).
   */
  const pushFirmwareReading = useCallback(
    async (input: {
      heartRate?: number;
      spo2?: number;
      temperatureC?: number;
    }) => {
      const { auth, db, rtdb } = getFirebaseClient();
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

      const optimisticRecord = parseFirmwareMeasurementDoc(
        uploadId,
        firestorePayload
      );
      setReadings((prev) => [optimisticRecord, ...prev]);
      setDevice((prev) => ({
        ...prev,
        status: "online",
        lastSeenMs: nowMs + serverTimeOffsetMs,
        anonymousUid: uid,
      }));
      setNowMs(nowMs);

      await Promise.all([
        setDoc(
          doc(db, "deviceReadings", uid, "measurements", uploadId),
          firestorePayload,
          { merge: true }
        ),
        update(ref(rtdb, "device"), {
          deviceId: DEVICE_ID,
          status: "online",
          lastSeen: serverTimestamp(),
        }),
      ]);
    },
    [serverTimeOffsetMs]
  );

  /**
   * Updates `/device` in Firebase Realtime Database matching `sendHeartbeat()` in firmware.
   */
  const setDeviceStatus = useCallback(
    async (nextStatus: "online" | "offline") => {
      const { rtdb } = getFirebaseClient();
      const nowMs = Date.now();

      setDevice((prev) => ({
        ...prev,
        status: nextStatus,
        lastSeenMs:
          nextStatus === "online"
            ? nowMs + serverTimeOffsetMs
            : prev.lastSeenMs,
      }));
      setNowMs(nowMs);

      await update(ref(rtdb, "device"), {
        deviceId: DEVICE_ID,
        status: nextStatus,
        ...(nextStatus === "online" ? { lastSeen: serverTimestamp() } : {}),
      });
    },
    [serverTimeOffsetMs]
  );

  const serverNowMs = nowMs + serverTimeOffsetMs;
  const hasSeenHeartbeat = device.lastSeenMs > 0;
  const elapsedMs = hasSeenHeartbeat
    ? Math.max(0, serverNowMs - device.lastSeenMs)
    : Infinity;
  const secondsSinceLastSeen = hasSeenHeartbeat
    ? Math.floor(elapsedMs / 1000)
    : null;
  const isTimedOut = !hasSeenHeartbeat || elapsedMs > HEARTBEAT_TIMEOUT_MS;
  const isOnline = device.status === "online" && !isTimedOut;

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
    rtdbConnected,
    firestoreError,
    pushFirmwareReading,
    setDeviceStatus,
  };
}
