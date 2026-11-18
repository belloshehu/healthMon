import { NextRequest, NextResponse } from "next/server";
import {
  getPlatformStore,
  Esp32DeviceCredentials,
} from "@/lib/domain/iotBackendService";
import { AuthorizationError } from "@/lib/auth/rbac";
import { DEV_DEVICE_SECRETS } from "@/lib/domain/seedData";

function extractDeviceCredentials(req: NextRequest): Esp32DeviceCredentials {
  const deviceId = req.headers.get("x-device-id") || "";
  const providedSecret = req.headers.get("x-device-secret") || "";
  const firebaseUid =
    req.headers.get("x-firebase-uid") || `anon_esp32_${deviceId}`;
  const isAnonymousOnly = req.headers.get("x-anonymous-only") === "true";

  // Allow the interactive hardware simulator to use known dev device secrets when x-use-dev-secret is set
  const deviceSecret =
    providedSecret === "__DEV_SIMULATOR_AUTO__"
      ? DEV_DEVICE_SECRETS[deviceId] || ""
      : providedSecret;

  return {
    deviceId,
    deviceSecret,
    firebaseUid,
    isAnonymousAuthOnly: isAnonymousOnly,
  };
}

export async function POST(req: NextRequest) {
  try {
    const store = getPlatformStore();
    const creds = extractDeviceCredentials(req);
    const body = await req.json();
    const { endpoint, payload } = body;

    switch (endpoint) {
      case "verifyPatientCodeAndCreateSession": {
        const result = store.verifyPatientCodeAndCreateSession(creds, payload);
        return NextResponse.json(result, { status: 201 });
      }
      case "uploadVitalMeasurement": {
        const result = store.uploadMeasurement(creds, payload);
        return NextResponse.json(result, {
          status: result.deduplicated ? 200 : 201,
        });
      }
      case "syncOfflineMeasurements": {
        const result = store.syncOfflineMeasurements(creds, payload);
        return NextResponse.json(result, { status: 200 });
      }
      case "completeMeasurementSession": {
        const session = store.completeMeasurementSession(creds, payload);
        return NextResponse.json({ session }, { status: 200 });
      }
      case "reportDeviceHeartbeat": {
        const device = store.reportDeviceHeartbeat(creds, payload);
        const { secretKeyHash: _h, ...safeDevice } = device;
        return NextResponse.json({ device: safeDevice }, { status: 200 });
      }
      case "directDemoUpload": {
        const measurement = store.recordDirectDemoReading(creds, payload);
        return NextResponse.json({ measurement }, { status: 201 });
      }
      case "setDeviceConnectionStatus": {
        const device = store.setDemoDeviceConnectionStatus(
          creds,
          payload.connectionStatus
        );
        const { secretKeyHash: _h, ...safeDevice } = device;
        return NextResponse.json({ device: safeDevice }, { status: 200 });
      }
      default:
        return NextResponse.json(
          {
            error: "UNKNOWN_IOT_ENDPOINT",
            message: `Unknown ESP32 endpoint '${endpoint}'`,
          },
          { status: 400 }
        );
    }
  } catch (err: unknown) {
    const status = err instanceof AuthorizationError ? err.statusCode : 400;
    return NextResponse.json(
      {
        error:
          err instanceof AuthorizationError ? err.code : "IOT_REQUEST_FAILED",
        message: err instanceof Error ? err.message : "ESP32 request failed",
      },
      { status }
    );
  }
}
