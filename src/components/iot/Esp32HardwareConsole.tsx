"use client";

import React, { useState } from "react";
import { MonitoringDevice } from "@/types/models";
import {
  Wifi,
  WifiOff,
  Cpu,
  UploadCloud,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Activity,
} from "lucide-react";

interface OfflineReadingItem {
  measurementId: string;
  patientCode: string;
  heartRateBpm: number;
  spo2Pct: number;
  surfaceTempC: number;
  capturedAt: string;
}

interface Esp32HardwareConsoleProps {
  devices: MonitoringDevice[];
  onMeasurementsUpdated: () => void;
}

const KEYPAD_KEYS = [
  "1",
  "2",
  "3",
  "A",
  "4",
  "5",
  "6",
  "B",
  "7",
  "8",
  "9",
  "C",
  "*",
  "0",
  "#",
  "D",
];

export function Esp32HardwareConsole({
  devices,
  onMeasurementsUpdated,
}: Esp32HardwareConsoleProps) {
  const activeDevices = devices.filter((d) => d.status === "active");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(
    activeDevices[0]?.deviceId || devices[0]?.deviceId || "dev_esp32_pti_01"
  );
  const [wifiOnline, setWifiOnline] = useState<boolean>(true);
  const [keypadCode, setKeypadCode] = useState<string>("102345");
  const [authorizedSession, setAuthorizedSession] = useState<{
    sessionId: string;
    patientCode: string;
    initials: string;
    ward: string;
    bedNumber: string;
  } | null>(null);

  const [capturedVitals, setCapturedVitals] = useState<{
    measurementId: string;
    heartRateBpm: number;
    spo2Pct: number;
    surfaceTempC: number;
    capturedAt: string;
  } | null>(null);

  const [heartRateInput, setHeartRateInput] = useState<number>(86);
  const [spo2Input, setSpo2Input] = useState<number>(97);
  const [surfaceTempInput, setSurfaceTempInput] = useState<number>(36.6);

  const [offlineQueue, setOfflineQueue] = useState<OfflineReadingItem[]>([]);
  const [lcdLines, setLcdLines] = useState<string[]>([
    "PTI ESP32 v2.4.2",
    "WIFI: ONLINE (TLS)",
    "PATIENT CODE:",
    "[ 102345 ] -> NEXT",
  ]);
  const [busy, setBusy] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "info" | "success" | "error";
    text: string;
  } | null>(null);

  const handleKeyPress = (key: string) => {
    if (key === "*") {
      const next = keypadCode.slice(0, -1);
      setKeypadCode(next);
      setLcdLines([
        "PTI ESP32 v2.4.2",
        wifiOnline ? "WIFI: ONLINE" : "WIFI: OFFLINE",
        "PATIENT CODE:",
        `[ ${next.padEnd(6, "_")} ]`,
      ]);
      return;
    }
    if (key === "#") {
      setKeypadCode("");
      setLcdLines([
        "PTI ESP32 v2.4.2",
        wifiOnline ? "WIFI: ONLINE" : "WIFI: OFFLINE",
        "CLEARED",
        "[ ______ ]",
      ]);
      return;
    }
    if (/^\d$/.test(key) && keypadCode.length < 6) {
      const next = keypadCode + key;
      setKeypadCode(next);
      setLcdLines([
        "PTI ESP32 v2.4.2",
        wifiOnline ? "WIFI: ONLINE" : "WIFI: OFFLINE",
        "PATIENT CODE:",
        `[ ${next.padEnd(6, "_")} ] ${next.length === 6 ? "-> NEXT" : ""}`,
      ]);
    }
  };

  const handleNextButton = async () => {
    if (!/^\d{6}$/.test(keypadCode)) {
      setStatusMessage({
        type: "error",
        text: "Enter a 6-digit code before pressing NEXT.",
      });
      return;
    }

    if (!wifiOnline) {
      setAuthorizedSession(null);
      setLcdLines([
        `OFFLINE: ${keypadCode}`,
        "UNVERIFIED",
        "READY TO SAMPLE",
        "PRESS CAPTURE",
      ]);
      setStatusMessage({
        type: "info",
        text: `Offline code ${keypadCode} staged. Press CAPTURE.`,
      });
      return;
    }

    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/iot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": selectedDeviceId,
          "x-device-secret": "__DEV_SIMULATOR_AUTO__",
        },
        body: JSON.stringify({
          endpoint: "verifyPatientCodeAndCreateSession",
          payload: {
            deviceId: selectedDeviceId,
            patientCode: keypadCode,
            operatorId: "esp32_keypad_operator",
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthorizedSession(null);
        setLcdLines([
          "AUTH ERROR",
          data.error || "FAILED",
          `CODE: ${keypadCode}`,
          "RETRY",
        ]);
        setStatusMessage({
          type: "error",
          text: data.message || "Code verification failed",
        });
        return;
      }

      setAuthorizedSession({
        sessionId: data.session.sessionId,
        patientCode: data.patientDisplay.patientCode,
        initials: data.patientDisplay.initials,
        ward: data.patientDisplay.ward,
        bedNumber: data.patientDisplay.bedNumber,
      });

      setLcdLines([
        `OK: ${data.patientDisplay.initials} (${keypadCode})`,
        `BED: ${data.patientDisplay.bedNumber}`,
        `SESS: ${data.session.sessionId.slice(0, 12)}`,
        "PRESS CAPTURE",
      ]);
      setStatusMessage({
        type: "success",
        text: `Verified ${data.patientDisplay.initials} (Bed ${data.patientDisplay.bedNumber}). Press CAPTURE.`,
      });
      onMeasurementsUpdated();
    } finally {
      setBusy(false);
    }
  };

  const handleCaptureButton = () => {
    if (!/^\d{6}$/.test(keypadCode)) {
      setStatusMessage({
        type: "error",
        text: "Enter a 6-digit patient code first.",
      });
      return;
    }

    const measurementId = `meas_${selectedDeviceId}_${Date.now()}`;
    const capturedAt = new Date().toISOString();

    setCapturedVitals({
      measurementId,
      heartRateBpm: heartRateInput,
      spo2Pct: spo2Input,
      surfaceTempC: surfaceTempInput,
      capturedAt,
    });

    setLcdLines([
      `HR:${heartRateInput} SpO2:${spo2Input}%`,
      `IR TEMP:${surfaceTempInput.toFixed(1)}C`,
      `CODE:${keypadCode}`,
      wifiOnline ? "PRESS UPLOAD" : "UPLOAD -> QUEUE",
    ]);

    setStatusMessage({
      type: "info",
      text: `Sampled ${heartRateInput} BPM, ${spo2Input}% SpO₂, ${surfaceTempInput.toFixed(1)} °C. Press UPLOAD.`,
    });
  };

  const handleUploadButton = async () => {
    if (!capturedVitals) {
      setStatusMessage({
        type: "error",
        text: "Press CAPTURE before UPLOAD.",
      });
      return;
    }

    if (!wifiOnline) {
      const queuedItem: OfflineReadingItem = {
        measurementId: capturedVitals.measurementId,
        patientCode: keypadCode,
        heartRateBpm: capturedVitals.heartRateBpm,
        spo2Pct: capturedVitals.spo2Pct,
        surfaceTempC: capturedVitals.surfaceTempC,
        capturedAt: capturedVitals.capturedAt,
      };
      setOfflineQueue((prev) => {
        if (prev.some((i) => i.measurementId === queuedItem.measurementId)) {
          return prev;
        }
        return [...prev, queuedItem];
      });
      setLcdLines([
        "QUEUED IN NVS",
        `CODE: ${keypadCode}`,
        `QUEUE: ${offlineQueue.length + 1}`,
        "AWAITING WIFI",
      ]);
      setStatusMessage({
        type: "info",
        text: `Queued offline (${offlineQueue.length + 1} pending). Switch Wi-Fi online to sync.`,
      });
      return;
    }

    if (!authorizedSession) {
      setStatusMessage({
        type: "error",
        text: "Press NEXT first to authorize session.",
      });
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/iot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": selectedDeviceId,
          "x-device-secret": "__DEV_SIMULATOR_AUTO__",
        },
        body: JSON.stringify({
          endpoint: "uploadVitalMeasurement",
          payload: {
            measurementId: capturedVitals.measurementId,
            sessionId: authorizedSession.sessionId,
            deviceId: selectedDeviceId,
            heartRateBpm: capturedVitals.heartRateBpm,
            spo2Pct: capturedVitals.spo2Pct,
            surfaceTempC: capturedVitals.surfaceTempC,
            capturedAt: capturedVitals.capturedAt,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLcdLines([
          "UPLOAD ERROR",
          data.error || "FAILED",
          "CHECK SESSION",
          "RETRY",
        ]);
        setStatusMessage({
          type: "error",
          text: data.message || "Upload failed",
        });
        return;
      }

      setLcdLines([
        data.deduplicated ? "ACK (DEDUP)" : "UPLOAD OK!",
        `PAT: ${authorizedSession.initials}`,
        `ALERT: ${String(data.measurement.alertLevel).toUpperCase()}`,
        "DONE",
      ]);
      setStatusMessage({
        type: "success",
        text: data.deduplicated
          ? "Duplicate ignored (idempotent)."
          : `Uploaded for ${authorizedSession.initials}.`,
      });
      onMeasurementsUpdated();
    } finally {
      setBusy(false);
    }
  };

  const handleSyncOfflineQueue = async () => {
    if (!wifiOnline) {
      setStatusMessage({
        type: "error",
        text: "Switch Wi-Fi to Online before syncing.",
      });
      return;
    }
    if (offlineQueue.length === 0) return;

    setBusy(true);
    try {
      const res = await fetch("/api/iot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": selectedDeviceId,
          "x-device-secret": "__DEV_SIMULATOR_AUTO__",
        },
        body: JSON.stringify({
          endpoint: "syncOfflineMeasurements",
          payload: {
            deviceId: selectedDeviceId,
            firmwareVersion: "v2.4.2",
            readings: offlineQueue,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatusMessage({
          type: "error",
          text: data.message || "Offline sync failed",
        });
        return;
      }

      setOfflineQueue([]);
      setLcdLines([
        "SYNC COMPLETE",
        `OK:${data.acceptedCount} DUP:${data.duplicateCount}`,
        `REJ:${data.rejectedCount}`,
        "PENDING VERIFY",
      ]);
      setStatusMessage({
        type: "success",
        text: `Synced: ${data.acceptedCount} accepted, ${data.duplicateCount} dedup, ${data.rejectedCount} rejected.`,
      });
      onMeasurementsUpdated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="esp32-console-heading"
      className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-slate-100 shadow-lg"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-sky-400" aria-hidden="true" />
          <h2 id="esp32-console-heading" className="text-sm font-bold text-white">
            ESP32 Keypad Simulator
          </h2>
          <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">
            128×64 GLCD • 4×4 Keypad
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <label htmlFor="esp32-device-select" className="sr-only">
            ESP32 Unit
          </label>
          <select
            id="esp32-device-select"
            name="deviceId"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white"
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.name} ({d.status})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              const nextState = !wifiOnline;
              setWifiOnline(nextState);
              setLcdLines((prev) => [
                prev[0],
                nextState ? "WIFI: ONLINE" : "WIFI: OFFLINE",
                prev[2],
                prev[3],
              ]);
            }}
            aria-pressed={wifiOnline}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              wifiOnline
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-amber-600 text-white hover:bg-amber-500"
            }`}
          >
            {wifiOnline ? (
              <>
                <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
                Online
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                Offline
              </>
            )}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* LCD + Action Buttons */}
        <div className="space-y-3 lg:col-span-5">
          <div
            role="status"
            aria-live="polite"
            className="rounded-xl border-2 border-slate-700 bg-[#9bbc0f] p-3.5 font-mono text-[#0f380f] shadow-inner"
          >
            <div className="mb-1.5 flex items-center justify-between border-b border-[#0f380f]/25 pb-1 text-[10px] font-bold">
              <span>128×64 LCD</span>
              <span>{wifiOnline ? "TLS" : "NVS QUEUE"}</span>
            </div>
            <div className="space-y-0.5 text-xs font-bold leading-snug">
              {lcdLines.map((line, idx) => (
                <div key={idx} className="truncate">
                  {line}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleNextButton}
              className="flex items-center justify-center gap-1 rounded-xl bg-sky-600 px-2.5 py-2.5 text-xs font-bold text-white hover:bg-sky-500 disabled:opacity-50"
            >
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              NEXT
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={handleCaptureButton}
              className="flex items-center justify-center gap-1 rounded-xl bg-teal-600 px-2.5 py-2.5 text-xs font-bold text-white hover:bg-teal-500 disabled:opacity-50"
            >
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
              CAPTURE
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={handleUploadButton}
              className="flex items-center justify-center gap-1 rounded-xl bg-indigo-600 px-2.5 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
              UPLOAD
            </button>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs">
            <span className="text-slate-400">
              Queue:{" "}
              <strong className="font-mono text-amber-400">
                {offlineQueue.length}
              </strong>
            </span>
            <button
              type="button"
              disabled={busy || offlineQueue.length === 0}
              onClick={handleSyncOfflineQueue}
              className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              Sync Queue
            </button>
          </div>
        </div>

        {/* 4x4 Keypad */}
        <div className="lg:col-span-3">
          <div className="grid grid-cols-4 gap-1.5 rounded-xl border border-slate-800 bg-slate-950 p-2.5">
            {KEYPAD_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => handleKeyPress(k)}
                aria-label={`Keypad key ${k}`}
                className="h-9 rounded-lg border border-slate-800 bg-slate-800/90 font-mono text-xs font-bold text-white hover:bg-slate-700 active:scale-95"
              >
                {k}
              </button>
            ))}
          </div>
        </div>

        {/* Sensor Sliders */}
        <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950 p-3.5 lg:col-span-4">
          <div>
            <div className="flex justify-between text-xs">
              <label htmlFor="sim-hr" className="text-slate-400">
                HR (MAX30102)
              </label>
              <span className="font-mono font-bold text-rose-400">
                {heartRateInput} BPM
              </span>
            </div>
            <input
              id="sim-hr"
              name="heartRateBpm"
              type="range"
              min={40}
              max={180}
              value={heartRateInput}
              onChange={(e) => setHeartRateInput(Number(e.target.value))}
              className="mt-1 w-full accent-rose-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <label htmlFor="sim-spo2" className="text-slate-400">
                SpO₂ (Prototype)
              </label>
              <span className="font-mono font-bold text-sky-400">
                {spo2Input}%
              </span>
            </div>
            <input
              id="sim-spo2"
              name="spo2Pct"
              type="range"
              min={75}
              max={100}
              value={spo2Input}
              onChange={(e) => setSpo2Input(Number(e.target.value))}
              className="mt-1 w-full accent-sky-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <label htmlFor="sim-temp" className="text-slate-400">
                IR Temp (MLX90614)
              </label>
              <span className="font-mono font-bold text-amber-400">
                {surfaceTempInput.toFixed(1)} °C
              </span>
            </div>
            <input
              id="sim-temp"
              name="surfaceTempC"
              type="range"
              min={33.0}
              max={41.0}
              step={0.1}
              value={surfaceTempInput}
              onChange={(e) => setSurfaceTempInput(Number(e.target.value))}
              className="mt-1 w-full accent-amber-500"
            />
          </div>
        </div>
      </div>

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
            statusMessage.type === "success"
              ? "border-emerald-500/30 bg-emerald-950/50 text-emerald-200"
              : statusMessage.type === "error"
              ? "border-rose-500/30 bg-rose-950/50 text-rose-200"
              : "border-sky-500/30 bg-sky-950/50 text-sky-200"
          }`}
        >
          {statusMessage.type === "success" ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          )}
          <span className="truncate">{statusMessage.text}</span>
        </div>
      )}
    </section>
  );
}
