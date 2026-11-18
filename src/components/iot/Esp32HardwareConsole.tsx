"use client";

import React, { useState } from "react";
import { Esp32DeviceState } from "@/hooks/useRealtimeVitals";
import {
  Wifi,
  WifiOff,
  Cpu,
  Send,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

interface Esp32HardwareConsoleProps {
  device: Esp32DeviceState;
  isOnline: boolean;
  onPushReading: (reading: {
    heartRate?: number;
    spo2?: number;
    temperatureC?: number;
  }) => Promise<void>;
  onToggleStatus: (nextStatus: "online" | "offline") => Promise<void>;
}

export function Esp32HardwareConsole({
  device,
  isOnline,
  onPushReading,
  onToggleStatus,
}: Esp32HardwareConsoleProps) {
  const [heartRateInput, setHeartRateInput] = useState<number>(82);
  const [spo2Input, setSpo2Input] = useState<number>(98);
  const [surfaceTempInput, setSurfaceTempInput] = useState<number>(36.5);
  const [includeHr, setIncludeHr] = useState<boolean>(true);
  const [includeSpo2, setIncludeSpo2] = useState<boolean>(true);
  const [includeTemp, setIncludeTemp] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const handleToggleConnection = async () => {
    const nextStatus = isOnline ? "offline" : "online";
    setBusy(true);
    setFeedback(null);
    try {
      await onToggleStatus(nextStatus);
      setFeedback({
        type: "success",
        text: `Device status set to ${nextStatus.toUpperCase()} in Firestore (/devices/${device.deviceId}).`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Failed to update device status in Firestore",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSendReading = async () => {
    if (!includeHr && !includeSpo2 && !includeTemp) {
      setFeedback({
        type: "error",
        text: "Nothing to upload — select at least one sensor parameter.",
      });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      await onPushReading({
        heartRate: includeHr ? heartRateInput : undefined,
        spo2: includeSpo2 ? spo2Input : undefined,
        temperatureC: includeTemp ? surfaceTempInput : undefined,
      });
      setFeedback({
        type: "success",
        text: "Uploaded to Firestore (deviceReadings/{uid}/measurements/{uploadId}).",
      });
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Firestore upload failed — check deployed firestore.rules",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="esp32-sim-heading"
      className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-slate-100 shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-sky-400" aria-hidden="true" />
          <h2
            id="esp32-sim-heading"
            className="text-xs font-bold uppercase tracking-wider text-slate-200"
          >
            ESP32 Firmware Simulator ({device.deviceId})
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleToggleConnection}
            aria-pressed={isOnline}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              isOnline
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-slate-700 text-slate-200 hover:bg-slate-600"
            }`}
          >
            {isOnline ? (
              <>
                <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
                Set Offline
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                Send Heartbeat (Online)
              </>
            )}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={handleSendReading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-bold text-white shadow hover:bg-sky-500 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            UPLOAD (PATCH Firestore)
          </button>
        </div>
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5">
              <input
                id="inc-hr"
                type="checkbox"
                checked={includeHr}
                onChange={(e) => setIncludeHr(e.target.checked)}
                className="h-3.5 w-3.5 accent-rose-500"
              />
              <label htmlFor="inc-hr" className="text-slate-300">
                heartRate
              </label>
            </span>
            <span className="font-mono font-bold text-rose-400">
              {includeHr ? `${heartRateInput} BPM` : "Not captured"}
            </span>
          </div>
          <input
            id="sim-hr"
            aria-label="Heart rate BPM"
            type="range"
            min={40}
            max={200}
            disabled={!includeHr}
            value={heartRateInput}
            onChange={(e) => setHeartRateInput(Number(e.target.value))}
            className="mt-2 w-full accent-rose-500 disabled:opacity-30"
          />
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5">
              <input
                id="inc-spo2"
                type="checkbox"
                checked={includeSpo2}
                onChange={(e) => setIncludeSpo2(e.target.checked)}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              <label htmlFor="inc-spo2" className="text-slate-300">
                spo2
              </label>
            </span>
            <span className="font-mono font-bold text-sky-400">
              {includeSpo2 ? `${spo2Input}%` : "Not captured"}
            </span>
          </div>
          <input
            id="sim-spo2"
            aria-label="SpO2 percentage"
            type="range"
            min={70}
            max={100}
            disabled={!includeSpo2}
            value={spo2Input}
            onChange={(e) => setSpo2Input(Number(e.target.value))}
            className="mt-2 w-full accent-sky-500 disabled:opacity-30"
          />
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5">
              <input
                id="inc-temp"
                type="checkbox"
                checked={includeTemp}
                onChange={(e) => setIncludeTemp(e.target.checked)}
                className="h-3.5 w-3.5 accent-amber-500"
              />
              <label htmlFor="inc-temp" className="text-slate-300">
                temperatureC
              </label>
            </span>
            <span className="font-mono font-bold text-amber-400">
              {includeTemp
                ? `${surfaceTempInput.toFixed(1)} °C`
                : "Not captured"}
            </span>
          </div>
          <input
            id="sim-temp"
            aria-label="Surface temperature Celsius"
            type="range"
            min={25.0}
            max={42.0}
            step={0.1}
            disabled={!includeTemp}
            value={surfaceTempInput}
            onChange={(e) => setSurfaceTempInput(Number(e.target.value))}
            className="mt-2 w-full accent-amber-500 disabled:opacity-30"
          />
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
            feedback.type === "success"
              ? "border-emerald-500/30 bg-emerald-950/50 text-emerald-200"
              : "border-rose-500/30 bg-rose-950/50 text-rose-200"
          }`}
        >
          {feedback.type === "success" ? (
            <CheckCircle2
              className="h-3.5 w-3.5 shrink-0 text-emerald-400"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="h-3.5 w-3.5 shrink-0 text-amber-400"
              aria-hidden="true"
            />
          )}
          <span>{feedback.text}</span>
        </div>
      )}
    </section>
  );
}
