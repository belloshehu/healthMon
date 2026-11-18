import {
  VitalAlertThresholds,
  VitalAlertLevel,
  MeasurementValidityStatus,
} from "@/types/models";

export const DEFAULT_HOSPITAL_THRESHOLDS: VitalAlertThresholds = {
  heartRateMinBpm: 50,
  heartRateMaxBpm: 110,
  spo2MinPct: 94,
  spo2CriticalPct: 90,
  surfaceTempMinC: 34.0,
  surfaceTempMaxC: 37.5,
};

export interface VitalEvaluationResult {
  alertLevel: VitalAlertLevel;
  validityStatus: MeasurementValidityStatus;
  alertFlags: string[];
}

/**
 * Evaluates vital sign readings against configurable hospital thresholds.
 * IMPORTANT:
 * - Does NOT label readings as medical diagnoses.
 * - Distinguishes MLX90614 infrared surface temperature from core body temperature.
 * - Treats MAX30102 optical readings as prototype measurements requiring clinical confirmation.
 */
export function evaluateVitalMeasurement(
  reading: {
    heartRateBpm: number;
    spo2Pct: number;
    surfaceTempC: number;
  },
  thresholds: VitalAlertThresholds = DEFAULT_HOSPITAL_THRESHOLDS
): VitalEvaluationResult {
  const alertFlags: string[] = [];
  let alertLevel: VitalAlertLevel = "normal";
  let validityStatus: MeasurementValidityStatus = "valid";

  // Check for likely optical motion artifact or poor contact on MAX30102 / MLX90614
  if (
    reading.heartRateBpm > 210 ||
    reading.heartRateBpm < 32 ||
    reading.surfaceTempC < 30.5
  ) {
    validityStatus = "artifact_suspected";
    alertFlags.push(
      "Sensor contact or motion artifact suspected — verify probe placement"
    );
  }

  // Heart rate threshold checks (MAX30102 prototype pulse rate)
  if (reading.heartRateBpm > thresholds.heartRateMaxBpm + 25 || reading.heartRateBpm < thresholds.heartRateMinBpm - 10) {
    alertLevel = "high_priority";
    alertFlags.push(
      `Pulse rate outside priority threshold (${reading.heartRateBpm} BPM vs ${thresholds.heartRateMinBpm}–${thresholds.heartRateMaxBpm} BPM reference)`
    );
  } else if (
    reading.heartRateBpm > thresholds.heartRateMaxBpm ||
    reading.heartRateBpm < thresholds.heartRateMinBpm
  ) {
    alertLevel = "warning";
    alertFlags.push(
      `Pulse rate outside typical range (${reading.heartRateBpm} BPM)`
    );
  }

  // SpO2 threshold checks (MAX30102 prototype optical oximetry)
  if (reading.spo2Pct < thresholds.spo2CriticalPct) {
    alertLevel = "high_priority";
    alertFlags.push(
      `Low prototype SpO₂ reading (${reading.spo2Pct}% < ${thresholds.spo2CriticalPct}% priority threshold) — confirm with clinical oximeter`
    );
  } else if (reading.spo2Pct < thresholds.spo2MinPct) {
    if (alertLevel === "normal") alertLevel = "warning";
    alertFlags.push(
      `Borderline prototype SpO₂ reading (${reading.spo2Pct}% < ${thresholds.spo2MinPct}% reference)`
    );
  }

  // MLX90614 Infrared Surface Temperature checks (NOT core clinical temperature)
  if (reading.surfaceTempC >= thresholds.surfaceTempMaxC + 1.0) {
    alertLevel = "high_priority";
    alertFlags.push(
      `Elevated MLX90614 IR surface temperature (${reading.surfaceTempC.toFixed(1)} °C) — confirm with calibrated clinical thermometer`
    );
  } else if (
    reading.surfaceTempC > thresholds.surfaceTempMaxC ||
    reading.surfaceTempC < thresholds.surfaceTempMinC
  ) {
    if (alertLevel === "normal") alertLevel = "warning";
    alertFlags.push(
      `IR surface temperature outside reference (${reading.surfaceTempC.toFixed(1)} °C; note: surface skin temp differs from core body temp)`
    );
  }

  return {
    alertLevel,
    validityStatus,
    alertFlags,
  };
}
