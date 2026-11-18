"use client";

import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { VitalMeasurement } from "@/types/models";
import { formatTimestamp } from "@/lib/utils";

interface VitalSignsChartProps {
  measurements: VitalMeasurement[];
  title?: string;
}

export function VitalSignsChart({
  measurements,
  title = "Vitals Trend",
}: VitalSignsChartProps) {
  const chartData = [...measurements]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .map((m) => ({
      id: m.id,
      time: new Date(m.capturedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      fullTime: formatTimestamp(m.capturedAt),
      patientName: m.patientName || m.patientCodeAtCapture,
      heartRateBpm: m.heartRateBpm,
      spo2Pct: m.spo2Pct,
      surfaceTempC: m.surfaceTempC,
      syncStatus: m.syncStatus,
    }));

  if (chartData.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
        No telemetry readings recorded yet.
      </div>
    );
  }

  return (
    <figure className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm">
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
          <span className="text-xs text-slate-500">
            MAX30102 (Prototype HR/SpO₂) • MLX90614 (Surface IR °C)
          </span>
        </div>
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          Non-Diagnostic
        </span>
      </figcaption>

      <div className="h-60 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="time" stroke="#64748b" fontSize={11} />
            <YAxis
              yAxisId="left"
              stroke="#64748b"
              fontSize={11}
              domain={[40, 180]}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#64748b"
              fontSize={11}
              domain={[25, 100]}
            />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="heartRateBpm"
              name="HR (BPM)"
              stroke="#e11d48"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="spo2Pct"
              name="SpO₂ (%)"
              stroke="#0284c7"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="surfaceTempC"
              name="IR Temp (°C)"
              stroke="#d97706"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
