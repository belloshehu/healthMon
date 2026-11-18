import { NextRequest, NextResponse } from "next/server";
import { getPlatformStore } from "@/lib/domain/iotBackendService";
import { AuthenticatedActor, AuthorizationError, enforceHospitalAccess } from "@/lib/auth/rbac";
import { UserRole, PTI_CLINIC_ID } from "@/types/models";

function extractActorFromHeaders(req: NextRequest): AuthenticatedActor {
  const uid = req.headers.get("x-actor-uid") || "usr_hosp_admin_pti";
  const store = getPlatformStore();
  const user = store.users.get(uid);

  if (!user) {
    throw new AuthorizationError("Unrecognized PTI Clinic staff user", "UNAUTHENTICATED", 401);
  }

  return {
    uid: user.uid,
    email: user.email,
    role: user.role as UserRole,
    hospitalId: PTI_CLINIC_ID,
    active: user.active,
  };
}

export async function GET(req: NextRequest) {
  try {
    const store = getPlatformStore();
    const actor = extractActorFromHeaders(req);

    enforceHospitalAccess(actor, PTI_CLINIC_ID, "patient:view");

    const hospital = store.hospitals.get(PTI_CLINIC_ID)!;
    const patients = store.listHospitalPatients(actor, PTI_CLINIC_ID);
    const devices = Array.from(store.devices.values())
      .filter((d) => d.hospitalId === PTI_CLINIC_ID)
      .map(({ secretKeyHash: _secret, ...safeDevice }) => safeDevice);

    const sessions = Array.from(store.measurementSessions.values())
      .filter((s) => s.hospitalId === PTI_CLINIC_ID)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const measurements = Array.from(store.measurements.values())
      .filter((m) => m.hospitalId === PTI_CLINIC_ID)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

    const members = Array.from(store.hospitalMembers.values()).filter(
      (m) => m.hospitalId === PTI_CLINIC_ID
    );

    const canViewAuditLogs =
      actor.role === "super_admin" || actor.role === "hospital_admin";
    const auditLogs = canViewAuditLogs
      ? store.auditLogs.filter((l) => l.hospitalId === PTI_CLINIC_ID)
      : [];

    return NextResponse.json({
      actor,
      currentHospital: hospital,
      users: Array.from(store.users.values()),
      patients,
      devices,
      sessions,
      measurements,
      members,
      auditLogs,
    });
  } catch (err: unknown) {
    const status = err instanceof AuthorizationError ? err.statusCode : 400;
    return NextResponse.json(
      {
        error: err instanceof AuthorizationError ? err.code : "BAD_REQUEST",
        message: err instanceof Error ? err.message : "Request failed",
      },
      { status }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const store = getPlatformStore();
    const actor = extractActorFromHeaders(req);
    const body = await req.json();
    const { action, payload } = body;

    switch (action) {
      case "register_patient": {
        const patient = store.registerPatient(actor, {
          ...payload,
          hospitalId: PTI_CLINIC_ID,
        });
        return NextResponse.json({ patient }, { status: 201 });
      }
      case "register_device": {
        const result = store.registerDevice(actor, {
          ...payload,
          hospitalId: PTI_CLINIC_ID,
        });
        const { secretKeyHash: _h, ...safeDevice } = result.device;
        return NextResponse.json(
          { device: safeDevice, provisionedSecret: result.provisionedSecret },
          { status: 201 }
        );
      }
      case "update_device_status": {
        const updated = store.updateDeviceStatus(
          actor,
          payload.deviceId,
          payload.status
        );
        const { secretKeyHash: _h, ...safeDevice } = updated;
        return NextResponse.json({ device: safeDevice });
      }
      case "verify_offline_measurement": {
        const updated = store.verifyOfflineMeasurement(
          actor,
          payload.measurementId,
          payload.decision,
          payload.rejectionReason
        );
        return NextResponse.json({ measurement: updated });
      }
      case "update_hospital_settings": {
        const updated = store.updateHospitalSettings(
          actor,
          PTI_CLINIC_ID,
          payload.settings
        );
        return NextResponse.json({ hospital: updated });
      }
      case "add_staff_member": {
        const member = store.addOrUpdateStaffMember(
          actor,
          PTI_CLINIC_ID,
          payload.staff
        );
        return NextResponse.json({ member }, { status: 201 });
      }
      default:
        return NextResponse.json(
          { error: "UNKNOWN_ACTION", message: `Unsupported action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err: unknown) {
    const status = err instanceof AuthorizationError ? err.statusCode : 400;
    return NextResponse.json(
      {
        error: err instanceof AuthorizationError ? err.code : "VALIDATION_ERROR",
        message: err instanceof Error ? err.message : "Operation failed",
      },
      { status }
    );
  }
}
