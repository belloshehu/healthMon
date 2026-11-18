"use client";

import React, { useState } from "react";
import { MonitoringDevice } from "@/types/models";
import {
  Wifi,
  WifiOff,
  Cpu,
  Send,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

interface Esp32HardwareConsoleProps {
  device: MonitoringDevice;
  onUpdated: () => void;
}

export function Esp32HardwareConsole({
  device,
  onUpdated,
}: Esp32HardwareConsoleProps) {
  const [heartRateInput, setHeartRateInput] = useState<number>(82);
  const [spo2Input, setSpo2Input] = useState<number>(98);
  const [surfaceTempInput, setSurfaceTempInput] = useState<number>(36.5);
  const [busy, setBusy] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const isOnline = device.connectionStatus === "online";

  const handleToggleConnection = async () => {
    const nextStatus = isOnline ? "offline" : "online";
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/iot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": device.deviceId,
          "x-device-secret": "__DEV_SIMULATOR_AUTO__",
        },
        body: JSON.stringify({
          endpoint: "setDeviceConnectionStatus",
          payload: {
            connectionStatus: nextStatus,
          },
        }),
      });
      if (res.ok) {
        setFeedback({
          type: "success",
          text: `ESP32 status set to ${nextStatus.toUpperCase()}.`,
        });
        onUpdated();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSendReading = async () => {
    if (!isOnline) {
      setFeedback({
        type: "error",
        text: "Device is currently OFFLINE. Switch it to ONLINE to transmit readings.",
      });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/iot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": device.deviceId,
          "x-device-secret": "__DEV_SIMULATOR_AUTO__",
        },
        body: JSON.stringify({
          endpoint: "directDemoUpload",
          payload: {
            heartRateBpm: heartRateInput,
            spo2Pct: spo2Input,
            surfaceTempC: surfaceTempInput,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({
          type: "error",
          text: data.message || "Failed to send reading",
        });
        return;
      }

      setFeedback({
        type: "success",
        text: `Transmitted: ${heartRateInput} BPM, ${spo2Input}% SpO₂, ${surfaceTempInput.toFixed(1)} °C.`,
      });
      onUpdated();
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
          <h2 id="esp32-sim-heading" className="text-xs font-bold uppercase tracking-wider text-slate-200">
            ESP32 Sensor Simulator ({device.serialNumber})
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
                Set Online
              </>
            )}
          </button>

          <button
            type="button"
            disabled={busy || !isOnline}
            onClick={handleSendReading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-bold text-white shadow hover:bg-sky-500 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Send Reading
          </button>
        </div>
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="flex justify-between text-xs">
            <label htmlFor="sim-hr" className="text-slate-400">
              Heart Rate (MAX30102)
            </label>
            <span className="font-mono font-bold text-rose-400">
              {heartRateInput} BPM
            </span>
          </div>
          <input
            id="sim-hr"
            name="heartRateBpm"
            type="range"
            min={45}
            max={175}
            value={heartRateInput}
            onChange={(e) => setHeartRateInput(Number(e.target.value))}
            className="mt-2 w-full accent-rose-500"
          />
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="flex justify-between text-xs">
            <label htmlFor="sim-spo2" className="text-slate-400">
              SpO₂ (MAX30102)
            </label>
            <span className="font-mono font-bold text-sky-400">
              {spo2Input}%
            </span>
          </div>
          <input
            id="sim-spo2"
            name="spo2Pct"
            type="range"
            min={80}
            max={100}
            value={spo2Input}
            onChange={(e) => setSpo2Input(Number(e.target.value))}
            className="mt-2 w-full accent-sky-500"
          />
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
          <div className="flex justify-between text-xs">
            <label htmlFor="sim-temp" className="text-slate-400">
              Temp (MLX90614 IR)
            </label>
            <span className="font-mono font-bold text-amber-400">
              {surfaceTempInput.toFixed(1)} °C
            </span>
          </div>
          <input
            id="sim-temp"
            name="surfaceTempC"
            type="range"
            min={34.0}
            max={40.5}
            step={0.1}
            value={surfaceTempInput}
            onChange={(e) => setSurfaceTempInput(Number(e.target.value))}
            className="mt-2 w-full accent-amber-500"
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
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}
    </section>
  );
}
