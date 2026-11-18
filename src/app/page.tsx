"use client";

import React, { useState } from "react";
import {
  usePlatformSnapshot,
  usePlatformMutations,
} from "@/hooks/usePlatformData";
import { PTI_CLINIC_NAME } from "@/types/models";
import { formatTimestamp } from "@/lib/utils";
import { VitalSignsChart } from "@/components/charts/VitalSignsChart";
import { Esp32HardwareConsole } from "@/components/iot/Esp32HardwareConsole";
import {
  HeartPulse,
  Droplets,
  Thermometer,
  Wifi,
  WifiOff,
  Sliders,
  BatteryCharging,
  Clock,
} from "lucide-react";

const ALERT_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  normal: {
    label: "Normal",
    className: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  warning: {
    label: "Warning",
    className: "bg-amber-100 text-amber-800 border-amber-200",
  },
  high_priority: {
    label: "Alert",
    className: "bg-rose-100 text-rose-800 border-rose-200",
  },
};

export default function SimplifiedDashboardPage() {
  const [showSimulator, setShowSimulator] = useState<boolean>(true);
  const { data, isLoading, error } = usePlatformSnapshot("usr_hosp_admin_pti");
  const mutations = usePlatformMutations("usr_hosp_admin_pti");

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2.5 bg-slate-50 p-8">
        <progress className="w-48" aria-label="Loading PTI Clinic telemetry" />
        <p className="text-xs font-medium text-slate-500">
          Connecting to ESP32 telemetry stream…
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <main className="mx-auto max-w-md p-8">
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-rose-900"
        >
          <h1 className="text-sm font-bold">Telemetry Error</h1>
          <p className="mt-1 text-xs">
            {error instanceof Error ? error.message : "Unable to load stream."}
          </p>
        </div>
      </main>
    );
  }

  // Dedicated single ESP32 device for the demo (`dev_esp32_pti_01`)
  const primaryDevice =
    data.devices.find((d) => d.deviceId === "dev_esp32_pti_01") ||
    data.devices[0];

  // Filter readings for the primary demo device (or fallback to all readings)
  const deviceMeasurements = data.measurements.filter(
    (m) => m.deviceId === primaryDevice.deviceId
  );
  const readings =
    deviceMeasurements.length > 0 ? deviceMeasurements : data.measurements;
  const latest = readings[0];

  const isOnline = primaryDevice.connectionStatus === "online";
  const latestAlert = ALERT_BADGE[latest?.alertLevel || "normal"];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Header with Live Device Online/Offline Status */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-md">
        <a
          href="#main-dashboard-heading"
          className="skip-link visually-hidden"
        >
          Skip to main content
        </a>

        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-700 text-white shadow-sm">
              <HeartPulse className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-extrabold tracking-tight text-slate-900">
                  {PTI_CLINIC_NAME}
                </span>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                  {primaryDevice.serialNumber}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                Remote Vital Signs Monitor
              </p>
            </div>
          </div>

          {/* Device Connectivity Status + Simulator Toggle */}
          <div className="flex items-center gap-2.5">
            <div
              role="status"
              aria-live="polite"
              className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-bold ${
                isOnline
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-slate-300 bg-slate-100 text-slate-700"
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  isOnline ? "animate-pulse bg-emerald-500" : "bg-slate-400"
                }`}
                aria-hidden="true"
              />
              {isOnline ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Device Online</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                  <span>Device Offline</span>
                </>
              )}
            </div>

            <div className="hidden items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 sm:flex">
              <span className="inline-flex items-center gap-1">
                <BatteryCharging
                  className="h-3.5 w-3.5 text-slate-500"
                  aria-hidden="true"
                />
                {primaryDevice.batteryPct ?? 88}%
              </span>
              <span className="text-slate-300">•</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                {formatTimestamp(primaryDevice.lastSeenAt)}
              </span>
            </div>

            <button
              type="button"
              onClick={() => setShowSimulator((prev) => !prev)}
              aria-expanded={showSimulator}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Sliders className="h-3.5 w-3.5 text-sky-700" aria-hidden="true" />
              {showSimulator ? "Hide Simulator" : "Simulate ESP32"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1
            id="main-dashboard-heading"
            tabIndex={-1}
            className="text-lg font-extrabold tracking-tight text-slate-900 sm:text-xl"
          >
            Live Vital Signs
          </h1>
          {latest && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>Last reading: {formatTimestamp(latest.capturedAt)}</span>
              <span
                className={`rounded-md border px-2 py-0.5 text-[11px] font-bold ${latestAlert.className}`}
              >
                {latestAlert.label}
              </span>
            </div>
          )}
        </div>

        {/* Collapsible ESP32 Simulator for Live Testing */}
        {showSimulator && (
          <Esp32HardwareConsole
            device={primaryDevice}
            onUpdated={() => mutations.invalidate()}
          />
        )}

        {/* 3 Hero Vital Parameter Cards */}
        <section
          aria-label="Current vital parameters"
          className="grid grid-cols-1 gap-4 sm:grid-cols-3"
        >
          {/* 1. Heart Rate (BPM) */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Heart Rate
              </span>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
                <HeartPulse className="h-4 w-4" aria-hidden="true" />
              </div>
            </div>

            <div className="mt-3 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-black tracking-tight text-slate-900">
                {latest ? latest.heartRateBpm : "—"}
              </span>
              <span className="text-sm font-bold text-rose-600">BPM</span>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
              <span>MAX30102 Sensor</span>
              <span>Ref: 50–110 BPM</span>
            </div>
          </div>

          {/* 2. Blood Oxygen (SpO2 %) */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Blood Oxygen (SpO₂)
              </span>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                <Droplets className="h-4 w-4" aria-hidden="true" />
              </div>
            </div>

            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="font-mono text-4xl font-black tracking-tight text-slate-900">
                {latest ? latest.spo2Pct : "—"}
              </span>
              <span className="text-lg font-bold text-sky-600">%</span>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
              <span>MAX30102 Optical</span>
              <span>Ref: 94–100%</span>
            </div>
          </div>

          {/* 3. Surface Temperature (°C) */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Surface Temp
              </span>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                <Thermometer className="h-4 w-4" aria-hidden="true" />
              </div>
            </div>

            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="font-mono text-4xl font-black tracking-tight text-slate-900">
                {latest ? latest.surfaceTempC.toFixed(1) : "—"}
              </span>
              <span className="text-lg font-bold text-amber-600">°C</span>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
              <span>MLX90614 IR</span>
              <span>Ref: 34.0–37.5 °C</span>
            </div>
          </div>
        </section>

        {/* Trend Chart for the 3 Parameters */}
        <VitalSignsChart
          measurements={readings}
          title="3-Parameter Telemetry Trend"
        />

        {/* Compact 5-Column Recent Readings Log */}
        <div
          tabIndex={0}
          role="region"
          aria-labelledby="readings-log-caption"
          className="table-wrapper"
        >
          <table
            style={
              {
                "--label-2": '"Heart Rate"',
                "--label-3": '"SpO₂"',
                "--label-4": '"Surface Temp"',
                "--label-5": '"Status"',
              } as React.CSSProperties
            }
          >
            <caption id="readings-log-caption">
              Recent Device Readings ({readings.length})
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Heart Rate</th>
                <th scope="col">SpO₂</th>
                <th scope="col">Surface Temp</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((m) => {
                const badge = ALERT_BADGE[m.alertLevel] || ALERT_BADGE.normal;
                return (
                  <tr key={m.id}>
                    <th scope="row" className="text-xs font-semibold">
                      {formatTimestamp(m.capturedAt)}
                    </th>
                    <td className="font-mono text-xs font-bold text-rose-600">
                      {m.heartRateBpm} BPM
                    </td>
                    <td className="font-mono text-xs font-bold text-sky-700">
                      {m.spo2Pct}%
                    </td>
                    <td className="font-mono text-xs font-bold text-amber-700">
                      {m.surfaceTempC.toFixed(1)} °C
                    </td>
                    <td>
                      <span
                        className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-bold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
