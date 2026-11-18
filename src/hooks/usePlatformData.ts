"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Hospital,
  AppUser,
  HospitalMember,
  Patient,
  MonitoringDevice,
  MeasurementSession,
  VitalMeasurement,
  AuditLogEntry,
  DeviceLifecycleStatus,
} from "@/types/models";
import { AuthenticatedActor } from "@/lib/auth/rbac";

export interface PlatformSnapshotResponse {
  actor: AuthenticatedActor;
  currentHospital: Hospital;
  users: AppUser[];
  patients: Patient[];
  devices: MonitoringDevice[];
  sessions: MeasurementSession[];
  measurements: VitalMeasurement[];
  members: HospitalMember[];
  auditLogs: AuditLogEntry[];
}

export function usePlatformSnapshot(actorUid: string) {
  return useQuery<PlatformSnapshotResponse>({
    queryKey: ["platformSnapshot", actorUid],
    queryFn: async () => {
      const res = await fetch("/api/platform", {
        headers: {
          "x-actor-uid": actorUid,
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to load PTI Clinic platform data");
      }
      return data;
    },
  });
}

export function usePlatformMutations(actorUid: string) {
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["platformSnapshot"] });
  };

  const postAction = async (action: string, payload: unknown) => {
    const res = await fetch("/api/platform", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actor-uid": actorUid,
      },
      body: JSON.stringify({ action, payload }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `Action '${action}' failed`);
    }
    return data;
  };

  const registerPatient = useMutation({
    mutationFn: (payload: unknown) => postAction("register_patient", payload),
    onSuccess: invalidate,
  });

  const registerDevice = useMutation({
    mutationFn: (payload: unknown) => postAction("register_device", payload),
    onSuccess: invalidate,
  });

  const updateDeviceStatus = useMutation({
    mutationFn: (payload: { deviceId: string; status: DeviceLifecycleStatus }) =>
      postAction("update_device_status", payload),
    onSuccess: invalidate,
  });

  const verifyOfflineMeasurement = useMutation({
    mutationFn: (payload: {
      measurementId: string;
      decision: "verified_offline" | "rejected";
      rejectionReason?: string;
    }) => postAction("verify_offline_measurement", payload),
    onSuccess: invalidate,
  });

  const updateHospitalSettings = useMutation({
    mutationFn: (payload: { settings: unknown }) =>
      postAction("update_hospital_settings", payload),
    onSuccess: invalidate,
  });

  const addStaffMember = useMutation({
    mutationFn: (payload: { staff: unknown }) =>
      postAction("add_staff_member", payload),
    onSuccess: invalidate,
  });

  return {
    registerPatient,
    registerDevice,
    updateDeviceStatus,
    verifyOfflineMeasurement,
    updateHospitalSettings,
    addStaffMember,
    invalidate,
  };
}
