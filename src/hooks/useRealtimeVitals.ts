"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ref,
  onValue,
  set,
  update,
  query,
  limitToLast,
} from "firebase/database";
import { getFirebaseClient } from "@/lib/firebase/client";
import { evaluateVitalMeasurement } from "@/lib/domain/vitalAlerts";
import { VitalMeasurement } from "@/types/models";

export const HEARTBEAT_TIMEOUT_MS = 60_000; // 60-second heartbeat timeout

export interface RtdbDeviceState {
  deviceId: string;
  serialNumber: string;
  status: "online" | "offline";
  lastSeen: number; // Unix epoch ms
  lastSeenIso: string;
  batteryPct: number;
  heartRateBpm?: number;
  spo2Pct?: number;
  surfaceTempC?: number;
}

const DEFAULT_DEVICE_STATE: RtdbDeviceState = {
  deviceId: "dev_esp32_pti_01",
  serialNumber: "ESP32-PTI-001",
  status: "online",
  lastSeen: Date.now(),
  lastSeenIso: new Date().toISOString(),
  batteryPct: 92,
  heartRateBpm: 82,
  spo2Pct: 98,
  surfaceTempC: 36.5,
};

function buildRecordFromRtdb(
  key: string,
  raw: Record<string, unknown>
): VitalMeasurement {
  const hr = Number(raw.heartRateBpm ?? 80);
  const spo2 = Number(raw.spo2Pct ?? 98);
  const temp = Number(raw.surfaceTempC ?? 36.5);
  const capturedAt =
    typeof raw.capturedAt === "string"
      ? raw.capturedAt
      : typeof raw.timestamp === "number"
      ? new Date(raw.timestamp).toISOString()
      : new Date().toISOString();

  const evalResult = evaluateVitalMeasurement({
    heartRateBpm: hr,
    spo2Pct: spo2,
    surfaceTempC: temp,
  });

  return {
    id: key,
    measurementId: key,
    hospitalId: "hosp_pti_clinic",
    patientId: "pat_pti_901a2b3c4d",
    patientName: "PTI Clinic User",
    patientCodeAtCapture: "102345",
    sessionId: "rtdb_live",
    deviceId: String(raw.deviceId || "dev_esp32_pti_01"),
    heartRateBpm: hr,
    spo2Pct: spo2,
    surfaceTempC: temp,
    tempSensorType: "MLX90614_SURFACE_IR",
    opticalSensorType: "MAX30102_PROTOTYPE",
    capturedAt,
    uploadedAt: capturedAt,
    syncStatus: "verified_online",
    validityStatus: evalResult.validityStatus,
    alertLevel: evalResult.alertLevel,
    alertFlags: evalResult.alertFlags,
    createdAt: capturedAt,
  };
}

export function useRealtimeVitals() {
  const [device, setDevice] = useState<RtdbDeviceState>(DEFAULT_DEVICE_STATE);
  const [readings, setReadings] = useState<VitalMeasurement[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [rtdbConnected, setRtdbConnected] = useState<boolean>(false);
  const [rtdbError, setRtdbError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  // 1-second clock to evaluate the 60-second heartbeat timeout
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const { rtdb } = getFirebaseClient();
    const deviceRef = ref(rtdb, "device");
    const readingsQuery = query(ref(rtdb, "readings"), limitToLast(30));

    const unsubDevice = onValue(
      deviceRef,
      async (snapshot) => {
        setRtdbConnected(true);
        setRtdbError(null);
        if (snapshot.exists()) {
          const val = snapshot.val();
          const lastSeenMs =
            typeof val.lastSeen === "number"
              ? val.lastSeen
              : val.lastSeenIso
              ? new Date(val.lastSeenIso).getTime()
              : Date.now();
          setDevice({
            deviceId: val.deviceId || "dev_esp32_pti_01",
            serialNumber: val.serialNumber || "ESP32-PTI-001",
            status: val.status === "offline" ? "offline" : "online",
            lastSeen: lastSeenMs,
            lastSeenIso:
              val.lastSeenIso || new Date(lastSeenMs).toISOString(),
            batteryPct: Number(val.batteryPct ?? 92),
            heartRateBpm:
              val.heartRateBpm !== undefined
                ? Number(val.heartRateBpm)
                : undefined,
            spo2Pct:
              val.spo2Pct !== undefined ? Number(val.spo2Pct) : undefined,
            surfaceTempC:
              val.surfaceTempC !== undefined
                ? Number(val.surfaceTempC)
                : undefined,
          });
        } else {
          // Initialize `/device` in Realtime Database if empty
          const initial: RtdbDeviceState = {
            ...DEFAULT_DEVICE_STATE,
            lastSeen: Date.now(),
            lastSeenIso: new Date().toISOString(),
          };
          try {
            await set(deviceRef, initial);
          } catch {
            // Ignore write error if rules are locked
          }
          setDevice(initial);
        }
        setIsLoading(false);
      },
      (err) => {
        setRtdbError(err.message);
        setIsLoading(false);
      }
    );

    const unsubReadings = onValue(
      readingsQuery,
      async (snapshot) => {
        if (snapshot.exists()) {
          const rawMap = snapshot.val() as Record<
            string,
            Record<string, unknown>
          >;
          const list = Object.entries(rawMap)
            .map(([key, item]) => buildRecordFromRtdb(key, item))
            .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
          setReadings(list);
        } else {
          // Seed 1 initial reading in `/readings` if empty
          const seedTs = Date.now();
          const seedId = `meas_${seedTs}`;
          const seedPayload = {
            id: seedId,
            deviceId: "dev_esp32_pti_01",
            heartRateBpm: 82,
            spo2Pct: 98,
            surfaceTempC: 36.5,
            timestamp: seedTs,
            capturedAt: new Date(seedTs).toISOString(),
            alertLevel: "normal",
          };
          try {
            await set(ref(rtdb, `readings/${seedId}`), seedPayload);
          } catch {
            setReadings([buildRecordFromRtdb(seedId, seedPayload)]);
          }
        }
      },
      (err) => {
        setRtdbError(err.message);
      }
    );

    return () => {
      unsubDevice();
      unsubReadings();
    };
  }, []);

  /**
   * Pushes a new 3-parameter reading to both `/readings/{id}` and `/device` in Firebase Realtime Database.
   */
  const pushRealtimeReading = useCallback(
    async (input: {
      heartRateBpm: number;
      spo2Pct: number;
      surfaceTempC: number;
    }) => {
      const { rtdb } = getFirebaseClient();
      const ts = Date.now();
      const iso = new Date(ts).toISOString();
      const readingId = `meas_${ts}`;

      const evaluation = evaluateVitalMeasurement(input);

      const readingPayload = {
        id: readingId,
        deviceId: device.deviceId,
        heartRateBpm: input.heartRateBpm,
        spo2Pct: input.spo2Pct,
        surfaceTempC: input.surfaceTempC,
        timestamp: ts,
        capturedAt: iso,
        alertLevel: evaluation.alertLevel,
      };

      const deviceUpdate: RtdbDeviceState = {
        ...device,
        status: "online",
        lastSeen: ts,
        lastSeenIso: iso,
        heartRateBpm: input.heartRateBpm,
        spo2Pct: input.spo2Pct,
        surfaceTempC: input.surfaceTempC,
      };

      // Optimistic local state update + Firebase RTDB write
      setDevice(deviceUpdate);
      setReadings((prev) => [
        buildRecordFromRtdb(readingId, readingPayload),
        ...prev,
      ]);
      setNowMs(ts);

      await Promise.all([
        set(ref(rtdb, `readings/${readingId}`), readingPayload),
        set(ref(rtdb, "device"), deviceUpdate),
      ]);
    },
    [device]
  );

  /**
   * Updates `/device/status` ("online" | "offline") and refreshes `lastSeen` in Firebase Realtime Database.
   */
  const setRealtimeDeviceStatus = useCallback(
    async (nextStatus: "online" | "offline") => {
      const { rtdb } = getFirebaseClient();
      const ts = Date.now();
      const iso = new Date(ts).toISOString();

      const updated: RtdbDeviceState = {
        ...device,
        status: nextStatus,
        lastSeen: nextStatus === "online" ? ts : device.lastSeen,
        lastSeenIso: nextStatus === "online" ? iso : device.lastSeenIso,
      };

      setDevice(updated);
      setNowMs(ts);
      await update(ref(rtdb, "device"), {
        status: nextStatus,
        ...(nextStatus === "online" ? { lastSeen: ts, lastSeenIso: iso } : {}),
      });
    },
    [device]
  );

  // Combine `/device/status` with the 60-second `lastSeen` heartbeat timeout
  const secondsSinceLastSeen = Math.max(
    0,
    Math.floor((nowMs - device.lastSeen) / 1000)
  );
  const isTimedOut = nowMs - device.lastSeen >= HEARTBEAT_TIMEOUT_MS;
  const isOnline = device.status === "online" && !isTimedOut;

  return {
    device,
    readings,
    isOnline,
    isTimedOut,
    secondsSinceLastSeen,
    isLoading,
    rtdbConnected,
    rtdbError,
    pushRealtimeReading,
    setRealtimeDeviceStatus,
  };
}
